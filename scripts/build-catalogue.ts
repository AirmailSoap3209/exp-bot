/**
 * Generates data/tasks/*.json (and data/bestiary/families.json) from data/sources/.
 *
 *   npm run catalogue:build
 *
 * Deterministic: same sources in, same files out. Review the git diff after a rebuild.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Task } from '../src/tasks/types.js';
import { buildCatalogue } from '../src/tasks/catalogue.js';
import type { Meta } from '../src/tasks/types.js';

const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

interface ResourceTiers { tier: number; amountRequired: number; unlocks: string[] }
const skillsRes = read<{ fetchedAt: string; skills: Record<string, { name: string; maxLevel: number; levels: { level: number; totalExpRequired: number; unlocks: string[] }[] }> }>('data/sources/hypixel-skills.json');
const collRes = read<{ fetchedAt: string; collections: Record<string, { name: string; items: Record<string, { name: string; maxTiers: number; tiers: ResourceTiers[] }> }> }>('data/sources/hypixel-collections.json');
const neuBest = read<{ source: string; fetchedAt: string; brackets: Record<string, number[]>; families: { island: string; islandName: string; name: string; cap: number; mobs: string[]; bracket: number }[] }>('data/sources/neu-bestiary.json');
const neuMinions = read<{ source: string; fetchedAt: string; maxTiers: Record<string, number> }>('data/sources/neu-minions.json');
const overrides = read<{ addMobs: { island: string; name: string; mobs: string[] }[] }>('data/sources/bestiary-overrides.json');
const wiki = read<any>('data/sources/wiki-xp.json');
const slayerTable = read<{ source: string; cumulativeXp: Record<string, number[]> }>('data/leveling/slayer.json');
const cataTable = read<{ source: string; perLevelXp: number[] }>('data/leveling/catacombs.json');

const WIKI = 'fandom wiki SkyBlock_Levels/Tasks, 2026-11-24';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const WORDS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const sbXp = (unlocks: string[]) => Number(unlocks.join(' ').match(/\+(\d+) SkyBlock XP/)?.[1] ?? 0);
const titleCase = (id: string) => id.toLowerCase().split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

function task(t: Omit<Task, 'monetary' | 'tracking'> & Partial<Pick<Task, 'monetary' | 'tracking'>>): Task {
  // Stable key order keeps rebuild diffs readable.
  const out: Task = {
    id: t.id, category: t.category, name: t.name, description: t.description, xp: t.xp,
    requires: t.requires, prerequisites: t.prerequisites, activity: t.activity,
    monetary: t.monetary ?? false, tracking: t.tracking ?? 'api', source: t.source,
  };
  if (t.location) out.location = t.location;
  if (t.group) out.group = t.group;
  if (t.tier) out.tier = t.tier;
  if (t.hypixelTaskId) out.hypixelTaskId = t.hypixelTaskId;
  if (t.minutes) out.minutes = t.minutes;
  return out;
}

/** Tasks for one tiered source; each tier requires the one before it. */
function tiers(n: number, make: (tier: number, prev: string | undefined) => Task | undefined): Task[] {
  const out: Task[] = [];
  for (let tier = 1; tier <= n; tier++) {
    const t = make(tier, out.at(-1)?.id);
    if (t) out.push(t);
  }
  return out;
}

// ---------- Skills ----------
function buildSkills(): Task[] {
  const source = `Hypixel resources/skyblock/skills, fetched ${skillsRes.fetchedAt}`;
  return Object.entries(skillsRes.skills).flatMap(([id, s]) => {
    const skill = id.toLowerCase();
    const levels = [...s.levels].sort((a, b) => a.level - b.level);
    return tiers(levels.length, (lv, prev) => {
      const l = levels[lv - 1]!;
      const xp = sbXp(l.unlocks);
      if (!xp) return undefined; // Runecrafting and Social give no SkyBlock XP
      return task({
        id: `skills.${skill}.level${lv}`, category: 'skills', name: `${s.name} level ${lv}`,
        description: `Reach ${s.name} level ${lv}`, xp,
        requires: { metric: `skills.${skill}.xp`, amount: l.totalExpRequired },
        prerequisites: prev ? [prev] : [], activity: `skill.${skill}`,
        source, group: `skills.${skill}`, tier: lv,
      });
    });
  });
}

// ---------- Collections ----------
/** Item IDs like "LOG:2" and "LOG_2" are different items, so ":" must survive slugging. */
const itemSlug = (item: string) => item.split(':').map(slug).join('-');
const collectionTaskId = (item: string, tier: number) => `collections.${itemSlug(item)}.tier${tier}`;

function buildCollections(): Task[] {
  const source = `Hypixel resources/skyblock/collections, fetched ${collRes.fetchedAt}`;
  return Object.entries(collRes.collections)
    .filter(([cat]) => cat !== 'RIFT') // Rift collections belong to the Rift category (later)
    .flatMap(([, c]) => Object.entries(c.items).flatMap(([item, i]) => {
      const sorted = [...i.tiers].sort((a, b) => a.tier - b.tier);
      return tiers(sorted.length, (n, prev) => {
        const t = sorted[n - 1]!;
        const xp = sbXp(t.unlocks);
        if (!xp) throw new Error(`Collection ${item} tier ${n} lists no SkyBlock XP`);
        return task({
          id: collectionTaskId(item, t.tier), category: 'collections', name: `${i.name} collection ${ROMAN[t.tier - 1] ?? t.tier}`,
          description: `Collect ${t.amountRequired.toLocaleString('en-US')} ${i.name} (co-op total)`, xp,
          requires: { metric: `collections.${item}`, amount: t.amountRequired },
          prerequisites: prev ? [prev] : [], activity: `collect.${itemSlug(item)}`,
          source, group: `collections.${itemSlug(item)}`, tier: t.tier,
        });
      });
    }));
}

// ---------- Minions ----------
function buildMinions(knownIds: Set<string>): Task[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  // Collection tier whose unlocks include "<Name> Minion Recipes".
  const recipeTier = new Map<string, string>();
  for (const c of Object.values(collRes.collections)) {
    for (const [item, i] of Object.entries(c.items)) {
      for (const t of i.tiers) {
        for (const u of t.unlocks) {
          const m = /^(.*?) Minion Recipes?$/.exec(u);
          if (m && !recipeTier.has(norm(m[1]!))) recipeTier.set(norm(m[1]!), collectionTaskId(item, t.tier));
        }
      }
    }
  }
  const tierXp: number[] = wiki.minionTierXp;
  const source = `${neuMinions.source}; tier XP from ${WIKI}`;
  const noRecipe: string[] = [];
  const tasks = Object.entries(neuMinions.maxTiers).flatMap(([genId, maxTier]) => {
    const id = genId.replace(/_GENERATOR$/, '');
    const name = titleCase(id);
    let unlock = recipeTier.get(norm(wiki.minionCollectionNames[id] ?? name));
    if (unlock && !knownIds.has(unlock)) {
      // e.g. Vampire Minion unlocks from a Rift collection, which isn't in the v1 catalogue.
      console.log(`  ${id} minion unlocks from ${unlock}, which is not in the catalogue; no prerequisite`);
      unlock = undefined;
    }
    if (!unlock) noRecipe.push(id);
    return tiers(maxTier, (tier, prev) => task({
      id: `minions.${slug(id)}.tier${tier}`, category: 'minions', name: `${name} Minion ${ROMAN[tier - 1]}`,
      description: `Craft a ${name} Minion ${ROMAN[tier - 1]} for the first time`, xp: tierXp[tier - 1]!,
      requires: { metric: `minions.crafted.${id}_${tier}`, amount: 1 },
      prerequisites: prev ? [prev] : unlock ? [unlock] : [], activity: `minion.${slug(id)}`,
      source, group: `minions.${slug(id)}`, tier,
    }));
  });
  console.log(`  minions with no collection unlock (unlocked another way): ${noRecipe.join(', ')}`);
  return tasks;
}

// ---------- Fairy souls ----------
function buildFairySouls(): Task[] {
  const f = wiki.fairySouls;
  return tiers(f.maxExchanges, (n, prev) => task({
    id: `fairy_souls.exchange${n}`, category: 'fairy_souls', name: `Fairy Soul exchange ${n}`,
    description: `Find ${f.soulsPerExchange * n} Fairy Souls in total and exchange them with Tia`, xp: f.xpPerExchange,
    requires: { metric: 'fairySouls.exchanges', amount: n },
    prerequisites: prev ? [prev] : [], activity: null, minutes: f.minutesPerExchange,
    source: `${WIKI}; minutes ${f.minutesNote}`, group: 'fairy_souls', tier: n,
  }));
}

// ---------- Bestiary ----------
function buildBestiary(): { tasks: Task[]; families: { id: string; name: string; island: string; mobs: string[]; tiers: number[] }[] } {
  const families = neuBest.families.map((f) => ({ ...f, mobs: [...f.mobs] }));
  for (const o of overrides.addMobs) {
    const fam = families.find((f) => f.island === o.island && f.name === o.name);
    if (!fam) throw new Error(`bestiary override: no family ${o.name} on ${o.island}`);
    fam.mobs.push(...o.mobs.filter((m) => !fam.mobs.includes(m)));
  }
  const source = `${neuBest.source} + bestiary-overrides.json; XP from ${WIKI}`;
  const out: ReturnType<typeof buildBestiary>['families'] = [];
  const tasks: Task[] = [];
  const seen = new Set<string>();
  for (const f of families) {
    const id = `${slug(f.island)}.${slug(f.name)}`;
    if (seen.has(id)) throw new Error(`duplicate bestiary family ${id}`);
    seen.add(id);
    const bracket = neuBest.brackets[String(f.bracket)];
    if (!bracket) throw new Error(`bestiary family ${id} uses unknown bracket ${f.bracket}`);
    const maxTier = bracket.findIndex((x) => x >= f.cap) + 1 || bracket.length;
    const thresholds = bracket.slice(0, maxTier);
    out.push({ id, name: f.name, island: f.islandName, mobs: f.mobs, tiers: thresholds });
    tasks.push(...tiers(maxTier, (tier, prev) => task({
      id: `bestiary.${id}.tier${tier}`, category: 'bestiary', name: `${f.name} Bestiary ${ROMAN[tier - 1] ?? tier}`,
      description: `Kill ${thresholds[tier - 1]!.toLocaleString('en-US')} ${f.name} in total`, xp: wiki.bestiary.xpPerFamilyTier,
      requires: { metric: `bestiary.family.${id}`, amount: thresholds[tier - 1]! },
      prerequisites: prev ? [prev] : [], activity: `combat.${id}`, location: f.islandName,
      source, group: `bestiary.${id}`, tier,
    })));
  }
  // Milestones: one per 10 family tiers; +10 XP every 10 milestones.
  const totalTiers = out.reduce((a, f) => a + f.tiers.length, 0);
  const step = wiki.bestiary.milestoneStep as number;
  const maxMilestone = Math.floor(totalTiers / 10 / step) * step;
  tasks.push(...tiers(maxMilestone / step, (n, prev) => task({
    id: `bestiary.milestone${n * step}`, category: 'bestiary', name: `Bestiary milestone ${n * step}`,
    description: `Reach Bestiary milestone ${n * step} (${n * step * 10} family tiers)`, xp: wiki.bestiary.milestoneXp,
    requires: { metric: 'bestiary.milestone', amount: n * step },
    prerequisites: prev ? [prev] : [], activity: 'combat.bestiary',
    source: `${WIKI}; ${wiki.bestiary.milestoneNote}`, group: 'bestiary.milestone', tier: n,
  })));
  return { tasks, families: out };
}

// ---------- Slayer ----------
function buildSlayer(): Task[] {
  const s = wiki.slayer;
  return Object.entries(s.bosses as Record<string, { name: string; taskId: string; maxTier: number; location: string }>).flatMap(([boss, b]) => {
    const cumulative = slayerTable.cumulativeXp[boss];
    if (!cumulative) throw new Error(`no slayer XP table for ${boss}`);
    const levelNote = boss === 'vampire' ? `; ${s.levelXpNote}` : '';
    const levels = tiers(cumulative.length, (lv, prev) => task({
      id: `slayer.${boss}.level${lv}`, category: 'slayer', name: `${b.name} Slayer level ${lv}`,
      description: `Reach ${cumulative[lv - 1]!.toLocaleString('en-US')} ${b.name} Slayer XP`, xp: s.levelXp[lv - 1],
      requires: { metric: `slayer.${boss}.xp`, amount: cumulative[lv - 1]! },
      prerequisites: prev ? [prev] : [], activity: `slayer.${boss}`, location: b.location,
      source: `XP: ${WIKI}${levelNote}; thresholds: ${slayerTable.source}`, group: `slayer.${boss}.level`, tier: lv,
    }));
    const kills = tiers(b.maxTier, (tier, prev) => task({
      id: `slayer.${boss}.tier${tier}`, category: 'slayer', name: `Defeat ${b.name} ${ROMAN[tier - 1]}`,
      description: `Defeat a tier ${ROMAN[tier - 1]} ${b.name} for the first time`, xp: s.bossTierXp[tier - 1],
      requires: { metric: `slayer.${boss}.kills.tier${tier}`, amount: 1 },
      prerequisites: prev ? [prev] : [], activity: `slayer.${boss}.t${tier}`, location: b.location,
      source: WIKI, group: `slayer.${boss}.tier`, tier,
      hypixelTaskId: `DEFEAT_${b.taskId}_SLAYER_${WORDS[tier - 1]}`,
    }));
    return [...levels, ...kills];
  });
}

// ---------- Catacombs ----------
function buildCatacombs(): Task[] {
  const c = wiki.catacombs;
  const cumulative = cataTable.perLevelXp.reduce<number[]>((acc, x) => [...acc, (acc.at(-1) ?? 0) + x], []);
  const levelXp = (lv: number) => (lv <= 39 ? c.levelXp['1-39'] : c.levelXp['40-50']);
  const source = `XP: ${WIKI}; thresholds: ${cataTable.source}`;
  const level = tiers(cumulative.length, (lv, prev) => task({
    id: `catacombs.level${lv}`, category: 'catacombs', name: `Catacombs level ${lv}`,
    description: `Reach Catacombs level ${lv}`, xp: levelXp(lv),
    requires: { metric: 'catacombs.xp', amount: cumulative[lv - 1]! },
    prerequisites: prev ? [prev] : [], activity: 'dungeons.catacombs', source, group: 'catacombs.level', tier: lv,
  }));
  const classes = (['healer', 'mage', 'berserk', 'archer', 'tank'] as const).flatMap((cls) =>
    tiers(c.classMaxLevel, (lv, prev) => task({
      id: `catacombs.class.${cls}.level${lv}`, category: 'catacombs', name: `${titleCase(cls)} level ${lv}`,
      description: `Reach ${titleCase(cls)} class level ${lv}`, xp: c.classLevelXp,
      requires: { metric: `catacombs.classes.${cls}.xp`, amount: cumulative[lv - 1]! },
      prerequisites: prev ? [prev] : [], activity: `dungeons.class.${cls}`, source, group: `catacombs.class.${cls}`, tier: lv,
    })),
  );
  const floorName = (f: number) => (f === 0 ? 'Entrance' : `Floor ${ROMAN[f - 1]}`);
  const floors: Task[] = [];
  for (const f of Object.keys(c.floorXp).map(Number).sort((a, b) => a - b)) {
    floors.push(task({
      id: `catacombs.floor${f}`, category: 'catacombs', name: `Complete Catacombs ${floorName(f)}`,
      description: `Complete The Catacombs ${floorName(f)} once`, xp: c.floorXp[f],
      requires: { metric: `catacombs.completions.${f}`, amount: 1 },
      prerequisites: f > 0 ? [`catacombs.floor${f - 1}`] : [], activity: `dungeons.f${f}`,
      source: WIKI, hypixelTaskId: `COMPLETE_CATACOMBS${f}`, group: 'catacombs.floor', tier: f + 1,
    }));
  }
  for (const f of Object.keys(c.masterFloorXp).map(Number).sort((a, b) => a - b)) {
    floors.push(task({
      id: `catacombs.master${f}`, category: 'catacombs', name: `Complete Master Mode ${floorName(f)}`,
      description: `Complete Master Mode Catacombs ${floorName(f)} once`, xp: c.masterFloorXp[f],
      requires: { metric: `catacombs.master.${f}`, amount: 1 },
      prerequisites: [f > 1 ? `catacombs.master${f - 1}` : 'catacombs.floor7'], activity: `dungeons.m${f}`,
      source: WIKI, hypixelTaskId: `COMPLETE_MASTER_CATACOMBS${f}`, group: 'catacombs.master', tier: f,
    }));
  }
  return [...level, ...classes, ...floors];
}

// ---------- Write ----------
function main() {
  const bestiary = buildBestiary();
  const collections = buildCollections();
  const out: Record<string, Task[]> = {
    skills: buildSkills(),
    collections,
    minions: buildMinions(new Set(collections.map((t) => t.id))),
    fairy_souls: buildFairySouls(),
    bestiary: bestiary.tasks,
    slayer: buildSlayer(),
    catacombs: buildCatacombs(),
  };
  // Validate before writing anything.
  const meta = read<Meta>('data/meta.json');
  buildCatalogue(meta, Object.entries(out).map(([cat, entries]) => ({ file: `tasks/${cat}.json`, entries })));

  mkdirSync('data/tasks', { recursive: true });
  mkdirSync('data/bestiary', { recursive: true });
  for (const [cat, tasks] of Object.entries(out)) {
    // One task per line: compact, but diffs stay per task.
    writeFileSync(`data/tasks/${cat}.json`, `[\n${tasks.map((t) => '  ' + JSON.stringify(t)).join(',\n')}\n]\n`);
    const wikiMax = meta.categories.find((c) => c.id === cat)?.wikiMaxXp;
    const total = tasks.reduce((a, t) => a + t.xp, 0);
    console.log(`  ${cat.padEnd(12)} ${String(tasks.length).padStart(5)} tasks  ${String(total).padStart(6)} XP${wikiMax ? `  (wiki max ${wikiMax})` : ''}`);
  }
  writeFileSync('data/bestiary/families.json', `[\n${bestiary.families.map((f) => '  ' + JSON.stringify(f)).join(',\n')}\n]\n`);
  console.log(`  wrote data/bestiary/families.json (${bestiary.families.length} families)`);
}

main();
