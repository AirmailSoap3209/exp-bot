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
import { BRACKET_NAMES, validateRate, type Bracket, type Range, type RateEntry } from '../src/estimate/types.js';

const read = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

interface ResourceTiers { tier: number; amountRequired: number; unlocks: string[] }
const skillsRes = read<{ fetchedAt: string; skills: Record<string, { name: string; maxLevel: number; levels: { level: number; totalExpRequired: number; unlocks: string[] }[] }> }>('data/sources/hypixel-skills.json');
const collRes = read<{ fetchedAt: string; collections: Record<string, { name: string; items: Record<string, { name: string; maxTiers: number; tiers: ResourceTiers[] }> }> }>('data/sources/hypixel-collections.json');
const neuBest = read<{ source: string; fetchedAt: string; brackets: Record<string, number[]>; families: { island: string; islandName: string; name: string; cap: number; mobs: string[]; bracket: number }[] }>('data/sources/neu-bestiary.json');
const neuMinions = read<{ source: string; fetchedAt: string; maxTiers: Record<string, number> }>('data/sources/neu-minions.json');
const overrides = read<{ addMobs: { island: string; name: string; mobs: string[] }[] }>('data/sources/bestiary-overrides.json');
const wiki = read<any>('data/sources/wiki-xp.json');
const slayerTable = read<{ source: string; cumulativeXp: Record<string, number[]> }>('data/leveling/slayer.json');
const rateDefaults = read<any>('data/sources/rate-defaults.json');
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
  if (t.access) out.access = t.access;
  if (t.hypixelTaskIdUnconfirmed) out.hypixelTaskIdUnconfirmed = true;
  return out;
}

// ---------- Access (data/sources/access.json, from hypixelskyblock.minecraft.wiki) ----------
const accessSrc = read<any>('data/sources/access.json');
const ACCESS_SRC = 'hypixelskyblock.minecraft.wiki, 2026-11-24 (data/sources/access.json)';

/** An Access for any-of these area IDs plus requirements that hold everywhere; undefined when there's nothing to check. */
function access(areaIds: string[], extra: { skills?: Record<string, number>; other?: string[] } = {}): Task['access'] {
  const anyOf = areaIds.map((id) => {
    const a = accessSrc.areas[id];
    if (!a) throw new Error(`access.json: unknown area ${id}`);
    return { id, name: a.name, ...(a.skills ? { skills: a.skills } : {}), ...(a.sbLevel ? { sbLevel: a.sbLevel } : {}), ...(a.hotm ? { hotm: a.hotm } : {}), ...(a.other ? { other: a.other } : {}) };
  });
  if (!anyOf.length && !extra.skills && !extra.other) return undefined;
  return { anyOf, ...(extra.skills ? { skills: extra.skills } : {}), ...(extra.other ? { other: extra.other } : {}) };
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
const collectionCategory = new Map<string, string>();

/** Item IDs like "LOG:2" and "LOG_2" are different items, so ":" must survive slugging. */
const itemSlug = (item: string) => item.split(':').map(slug).join('-');
const collectionTaskId = (item: string, tier: number) => `collections.${itemSlug(item)}.tier${tier}`;

function buildCollections(): Task[] {
  const source = `Hypixel resources/skyblock/collections, fetched ${collRes.fetchedAt}`;
  return Object.entries(collRes.collections)
    .filter(([cat]) => cat !== 'RIFT') // Rift collections belong to the Rift category (later)
    .flatMap(([cat, c]) => Object.entries(c.items).flatMap(([item, i]) => {
      collectionCategory.set(itemSlug(item), rateDefaults.collections.itemClass?.[item] ?? cat);
      const sorted = [...i.tiers].sort((a, b) => a.tier - b.tier);
      const ca = accessSrc.collections[item] as { areas: string[]; other?: string[] } | undefined;
      const itemAccess = ca ? access(ca.areas, ca.other ? { other: ca.other } : {}) : undefined;
      return tiers(sorted.length, (n, prev) => {
        const t = sorted[n - 1]!;
        const xp = sbXp(t.unlocks);
        if (!xp) throw new Error(`Collection ${item} tier ${n} lists no SkyBlock XP`);
        return task({
          id: collectionTaskId(item, t.tier), category: 'collections', name: `${i.name} collection ${ROMAN[t.tier - 1] ?? t.tier}`,
          description: `Collect ${t.amountRequired.toLocaleString('en-US')} ${i.name} (co-op total)`, xp,
          requires: { metric: `collections.${item}`, amount: t.amountRequired },
          prerequisites: prev ? [prev] : [], activity: `collect.${itemSlug(item)}`,
          source: itemAccess ? `${source}; access: ${ACCESS_SRC}` : source, group: `collections.${itemSlug(item)}`, tier: t.tier, access: itemAccess,
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
      source: `${source}; minutes ${rateDefaults.minionNote}`, group: `minions.${slug(id)}`, tier,
      minutes: rateDefaults.minionTierMinutes[tier - 1],
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
function buildBestiary(): { tasks: Task[]; families: { id: string; name: string; island: string; bracket: number; mobs: string[]; tiers: number[] }[] } {
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
    out.push({ id, name: f.name, island: f.islandName, bracket: f.bracket, mobs: f.mobs, tiers: thresholds });
    // Where the mob is found: an island default, overridden per family (sea creatures also need a Fishing level).
    const o = accessSrc.bestiaryFamilies[id] as { area?: string | null; fishing?: number } | undefined;
    const areaId = o && 'area' in o ? o.area : accessSrc.bestiaryIslands[f.islandName];
    const famAccess = access(areaId ? [areaId] : [], o?.fishing ? { skills: { fishing: o.fishing } } : {});
    // Dungeon mobs: the first floor they appear on must be reachable (same gates as entering that floor).
    let floorGate: string[] = [];
    if (f.islandName === 'Catacombs') {
      const floor = accessSrc.catacombsMobFloors[slug(f.name)] as number | undefined;
      if (floor === undefined) throw new Error(`access.json: no catacombsMobFloors entry for ${slug(f.name)}`);
      const u = wiki.catacombs.unlocks;
      floorGate = floor === 0 ? [`skills.combat.level${u.entranceCombatLevel}`] : [`catacombs.floor${floor - 1}`, `catacombs.level${u.floorCatacombsLevel[floor]}`];
    }
    tasks.push(...tiers(maxTier, (tier, prev) => task({
      id: `bestiary.${id}.tier${tier}`, category: 'bestiary', name: `${f.name} Bestiary ${ROMAN[tier - 1] ?? tier}`,
      description: `Kill ${thresholds[tier - 1]!.toLocaleString('en-US')} ${f.name} in total`, xp: wiki.bestiary.xpPerFamilyTier,
      requires: { metric: `bestiary.family.${id}`, amount: thresholds[tier - 1]! },
      prerequisites: prev ? [prev] : floorGate, activity: `combat.${id}`, location: f.islandName,
      source: famAccess || floorGate.length ? `${source}; access: ${ACCESS_SRC}` : source, group: `bestiary.${id}`, tier, access: famAccess,
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
    // Unlocks: another boss's tier opens this boss; Combat level (and slayer level for Tier V) gates each tier.
    const u = s.unlocks;
    const unlock: string[] = u.bossUnlock[boss] ? [`slayer.${u.bossUnlock[boss]}`] : [];
    const exempt = (u.exempt as string[]).includes(boss);
    const gates = (tier: number): string[] => {
      if (exempt) return [];
      const combat = u.tierCombatLevel[tier - 1] as number | null;
      return [...(combat ? [`skills.combat.level${combat}`] : []), ...(tier === 5 ? [`slayer.${boss}.level${u.tier5SlayerLevel}`] : [])];
    };
    const unlockNote = `; unlocks: ${u.source}`;
    const bossArea = accessSrc.slayer[boss] as string | undefined;
    const bossAccess = bossArea ? access([bossArea]) : undefined;
    const levels = tiers(cumulative.length, (lv, prev) => task({
      id: `slayer.${boss}.level${lv}`, category: 'slayer', name: `${b.name} Slayer level ${lv}`,
      description: `Reach ${cumulative[lv - 1]!.toLocaleString('en-US')} ${b.name} Slayer XP`, xp: s.levelXp[lv - 1],
      requires: { metric: `slayer.${boss}.xp`, amount: cumulative[lv - 1]! },
      prerequisites: prev ? [prev] : unlock, activity: `slayer.${boss}`, location: b.location,
      source: `XP: ${WIKI}${levelNote}; thresholds: ${slayerTable.source}${unlock.length ? unlockNote : ''}`, group: `slayer.${boss}.level`, tier: lv, access: bossAccess,
    }));
    const kills = tiers(b.maxTier, (tier, prev) => task({
      id: `slayer.${boss}.tier${tier}`, category: 'slayer', name: `Defeat ${b.name} ${ROMAN[tier - 1]}`,
      description: `Defeat a tier ${ROMAN[tier - 1]} ${b.name} for the first time`, xp: s.bossTierXp[tier - 1],
      requires: { metric: `slayer.${boss}.kills.tier${tier}`, amount: 1 },
      prerequisites: [...(prev ? [prev] : unlock), ...gates(tier)], activity: `slayer.${boss}.t${tier}`, location: b.location,
      source: `${WIKI}${unlock.length || gates(tier).length ? unlockNote : ''}`, group: `slayer.${boss}.tier`, tier, access: bossAccess,
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
  // Catacombs level needed to enter a floor; level 0 or missing means no gate.
  const cataGate = (lv: number | undefined): string[] => (lv && lv > 0 ? [`catacombs.level${lv}`] : []);
  const floors: Task[] = [];
  for (const f of Object.keys(c.floorXp).map(Number).sort((a, b) => a - b)) {
    floors.push(task({
      id: `catacombs.floor${f}`, category: 'catacombs', name: `Complete Catacombs ${floorName(f)}`,
      description: `Complete The Catacombs ${floorName(f)} once`, xp: c.floorXp[f],
      requires: { metric: `catacombs.completions.${f}`, amount: 1 },
      prerequisites: f > 0
        ? [`catacombs.floor${f - 1}`, ...cataGate(c.unlocks.floorCatacombsLevel[f])]
        : [`skills.combat.level${c.unlocks.entranceCombatLevel}`],
      activity: `dungeons.f${f}`,
      source: `${WIKI}; unlocks: ${c.unlocks.source}`, hypixelTaskId: `COMPLETE_CATACOMBS${f}`, group: 'catacombs.floor', tier: f + 1,
    }));
  }
  for (const f of Object.keys(c.masterFloorXp).map(Number).sort((a, b) => a - b)) {
    floors.push(task({
      id: `catacombs.master${f}`, category: 'catacombs', name: `Complete Master Mode ${floorName(f)}`,
      description: `Complete Master Mode Catacombs ${floorName(f)} once`, xp: c.masterFloorXp[f],
      requires: { metric: `catacombs.master.${f}`, amount: 1 },
      prerequisites: [f > 1 ? `catacombs.master${f - 1}` : 'catacombs.floor7', ...cataGate(c.unlocks.masterCatacombsLevel[f])],
      activity: `dungeons.m${f}`,
      source: `${WIKI}; unlocks: ${c.unlocks.source}`, hypixelTaskId: `COMPLETE_MASTER_CATACOMBS${f}`, group: 'catacombs.master', tier: f,
    }));
  }
  return [...level, ...classes, ...floors];
}

// ---------- Rates ----------
const scale = (b: Record<Bracket, Range>, f: number): Record<Bracket, Range> =>
  Object.fromEntries(BRACKET_NAMES.map((k) => [k, b[k].map((x) => Number((x * f).toPrecision(3))) as Range])) as Record<Bracket, Range>;

/** One rate per activity used by a task without fixed minutes. */
function buildRates(tasks: Task[], families: { id: string; bracket: number }[]): Record<string, RateEntry[]> {
  const d = rateDefaults;
  const src = 'data/sources/rate-defaults.json';
  /** Bracket maps in rate-defaults may carry a "basis" note; keep only the three brackets. */
  const only = (b: any): Record<Bracket, Range> => Object.fromEntries(BRACKET_NAMES.map((k) => [k, b[k]])) as Record<Bracket, Range>;
  const why = (basis?: string) => (basis ? `${src}; ${basis}` : src);
  const familyBracket = new Map(families.map((f) => [f.id, f.bracket]));
  // Kills needed for tier 10 in each NEU bracket, relative to the base bracket.
  const tier10 = (b: number) => neuBest.brackets[String(b)]![9]!;
  const out: Record<string, Map<string, RateEntry>> = {};
  const put = (file: string, e: RateEntry) => ((out[file] ??= new Map()).set(e.activity, { ...e, source: e.source ?? src }));
  // Minimum time per task: one boss, one dungeon run, one Kuudra run (rate-defaults minimumMinutes).
  const r3 = (x: number) => Number(x.toPrecision(3));
  const perBracket = (f: (k: Bracket) => Range) => Object.fromEntries(BRACKET_NAMES.map((k) => [k, f(k)])) as Record<Bracket, Range>;
  const bossMin = perBracket((k) => { const [lo, hi] = d.slayerBoss.brackets[k] as Range; return [r3(1 / hi), r3(1 / lo)]; });
  const runMin = perBracket((k) => {
    const runs = Object.values(d.floors.minutesPerRun.normal as Record<string, Record<Bracket, Range>>).map((r) => r[k]);
    return [Math.min(...runs.map((r) => r[0])), Math.min(...runs.map((r) => r[1]))];
  });
  const kuudraMin = only(d.minimumMinutes.kuudraRun);
  const minNote = (what: string) => `; at least one ${what} per task (${d.minimumMinutes.basis.split('.')[0]})`;

  for (const t of tasks) {
    const a = t.activity;
    if (!a || t.minutes) continue;
    const parts = a.split('.');
    if (a === 'combat.bestiary') put('bestiary', { activity: a, unit: d.bestiaryMilestone.unit, bracketBy: d.bestiaryMilestone.bracketBy, brackets: only(d.bestiaryMilestone.brackets), source: why(d.bestiaryMilestone.basis) });
    else if (parts[0] === 'combat') {
      const fam = a.slice('combat.'.length);
      const b = familyBracket.get(fam);
      if (b === undefined) throw new Error(`rates: no bestiary family for ${a}`);
      const min = fam.startsWith('catacombs.') ? { m: runMin, what: 'dungeon run' } : fam.startsWith('kuudra.') ? { m: kuudraMin, what: `Kuudra run, ${d.minimumMinutes.kuudraRun.basis}` } : undefined;
      put('bestiary', {
        activity: a, unit: d.bestiary.unit, bracketBy: d.bestiary.bracketBy,
        brackets: scale(only(d.bestiary.base), tier10(b) / tier10(d.bestiary.baseBracket)),
        ...(min ? { minMinutes: min.m } : {}),
        source: `${why(d.bestiary.basis)}; scaled for NEU kill bracket ${b}${min ? minNote(min.what) : ''}`,
      });
    } else if (parts[0] === 'collect') {
      const cat = collectionCategory.get(parts.slice(1).join('.'));
      const c = cat && d.collections.byResourceCategory[cat];
      if (!c) throw new Error(`rates: no collection rate class for ${a}`);
      put('collections', { activity: a, unit: d.collections.unit, bracketBy: c.bracketBy, brackets: only(c.brackets), source: why(c.basis) });
    } else if (parts[0] === 'garden' && parts[1] === 'crop') {
      // Crop milestones: farming that crop in the Garden, at the crop's collection rate. Its own
      // activity, so a session measures milestone crops and collection items separately.
      const item = parts.slice(2).join('.');
      const cat = collectionCategory.get(item);
      const c = cat && d.collections.byResourceCategory[cat];
      if (!c) throw new Error(`rates: no collection rate class for ${a}`);
      put('collections', { activity: a, unit: 'crops/min', bracketBy: c.bracketBy, brackets: only(c.brackets), source: `${why(c.basis)}; same as collect.${item}, farmed in the Garden` });
    } else if (parts[0] === 'skill') {
      const b = d.skills.bySkill[parts[1]!];
      if (!b) throw new Error(`rates: no skill rate for ${a}`);
      put('skills', { activity: a, unit: d.skills.unit, bracketBy: `skill.${parts[1]}`, brackets: only(b), source: why(b.basis) });
    } else if (parts[0] === 'slayer' && parts.length === 2) {
      put('slayer', { activity: a, unit: d.slayerXp.unit, bracketBy: `slayer.${parts[1]}`, brackets: only(d.slayerXp.byBoss[parts[1]!] ?? d.slayerXp.default), minMinutes: bossMin, source: why(d.slayerXp.basis) + minNote('boss') });
    } else if (parts[0] === 'slayer' && parts.length === 3) {
      put('slayer', { activity: a, unit: d.slayerBoss.unit, bracketBy: `slayer.${parts[1]}`, brackets: only(d.slayerBoss.brackets), source: why(d.slayerBoss.basis) });
    } else if (a === 'dungeons.catacombs') {
      put('catacombs', { activity: a, unit: d.catacombsXp.unit, bracketBy: 'dungeons', brackets: only(d.catacombsXp.brackets), minMinutes: runMin, source: why(d.catacombsXp.basis) + minNote('dungeon run') });
    } else if (parts[0] === 'dungeons' && parts[1] === 'class') {
      put('catacombs', { activity: a, unit: d.classXp.unit, bracketBy: 'dungeons', brackets: only(d.classXp.brackets), minMinutes: runMin, source: why(d.classXp.basis) + minNote('dungeon run') });
    } else if (parts[0] === 'dungeons' && /^[fm]\d$/.test(parts[1] ?? '')) {
      // Stored as minutes per run (easier to check against the Speed time limits); rate = 1 / minutes.
      const floor = parts[1]!;
      const mode = floor[0] === 'f' ? 'normal' : 'master';
      const minutes = d.floors.minutesPerRun[mode][floor.slice(1)] as Record<Bracket, Range> | undefined;
      if (!minutes) throw new Error(`rates: no run time for ${a}`);
      const brackets = Object.fromEntries(BRACKET_NAMES.map((k) => [k, [1 / minutes[k][1], 1 / minutes[k][0]].map((x) => Number(x.toPrecision(3)))])) as Record<Bracket, Range>;
      put('catacombs', { activity: a, unit: d.floors.unit, bracketBy: 'dungeons', brackets, source: `${src}; ${d.floors.basis}` });
    } else throw new Error(`rates: no rule for activity ${a}`);
  }
  const files = Object.fromEntries(Object.entries(out).map(([f, m]) => [f, [...m.values()].sort((x, y) => x.activity.localeCompare(y.activity))]));
  const problems = Object.entries(files).flatMap(([f, list]) => list.flatMap((r, i) => validateRate(r, `rates/${f}.json[${i}]`)));
  if (problems.length) throw new Error(`invalid rates:\n  ${problems.join('\n  ')}`);
  return files;
}

// ---------- Write ----------
// ---------- SkyBlock Leveling task groups (data/sources/leveling-tasks.json) ----------
interface LevelingGroup {
  category: string;
  group: string;
  name: string;
  location?: string;
  access?: string[];
  chain?: boolean;
  /** A rated activity (e.g. collect.wheat for crop milestones): time comes from its rate, not fixed minutes. */
  activity?: string;
  minutes?: Range;
  perTier?: Range[];
  minutesBasis: string;
  tiers: { key: string; name: string; xp: number; id?: string; idSeen?: false; metric?: string; amount?: number; prerequisites?: string[]; tracking?: 'manual' }[];
}

/**
 * Every group becomes one tiered source. A tier with a Hypixel task ID is checked against the
 * completed-task list (metric task.<ID>); a tier with a metric is read by its category's reader.
 * Chained groups need the tier before. Tiers use fixed time estimates, or the group's activity rate.
 */
function buildLeveling(): Record<string, Task[]> {
  const src = read<{ source: string; groups: LevelingGroup[] }>('data/sources/leveling-tasks.json');
  const out: Record<string, Task[]> = {};
  for (const g of src.groups) {
    const acc = g.access ? access(g.access) : undefined;
    const tasks = tiers(g.tiers.length, (n, prev) => {
      const t = g.tiers[n - 1]!;
      const minutes = g.activity ? undefined : g.perTier?.[n - 1] ?? g.minutes;
      if (!minutes && !g.activity) throw new Error(`leveling-tasks: ${g.group} has no minutes for tier ${n}`);
      return task({
        id: `${g.group}.${t.key}`, category: g.category, name: t.name,
        description: `${g.name}${g.tiers.length > 1 ? `, step ${n} of ${g.tiers.length}` : ''}`, xp: t.xp,
        requires: { metric: t.metric ?? `task.${t.id}`, amount: t.amount ?? 1 },
        prerequisites: [...(g.chain && prev ? [prev] : []), ...(t.prerequisites ?? [])], activity: g.activity ?? null, minutes,
        ...(t.tracking ? { tracking: t.tracking } : {}),
        location: g.location, group: g.group, tier: n, access: acc,
        source: `XP: ${src.source.split(',')[0]}; time: ${g.minutesBasis}${acc ? `; access: ${ACCESS_SRC}` : ''}`,
        ...(t.id ? { hypixelTaskId: t.id } : {}), ...(t.idSeen === false ? { hypixelTaskIdUnconfirmed: true } : {}),
      });
    });
    (out[g.category] ??= []).push(...tasks);
  }
  return out;
}

// ---------- Gathering combos (data/sources/combo-sources.json) ----------
/**
 * One combo per gathered collection whose block gives skill XP: the collection is the primary,
 * skill XP per item is XP per block / (base items x (1 + fortune/100)) per bracket. Crops are
 * farmed in the Garden, so they also count toward the crop's milestone.
 */
function buildGatheringCombos(rates: Record<string, RateEntry[]>, tasks: Task[]) {
  const src = read<any>('data/sources/combo-sources.json');
  const rated = new Set(Object.values(rates).flat().map((r) => r.activity));
  const metrics = new Set(tasks.map((t) => t.requires.metric));
  const r3 = (x: number) => Number(x.toPrecision(3));
  const VERB: Record<string, [string, string]> = { farming: ['farm', 'Farm'], mining: ['mine', 'Mine'], foraging: ['chop', 'Chop'] };
  const combos: unknown[] = [];
  type Gathered = { name: string; xp: number; base?: Range; baseBasis?: string; pristine?: Record<string, Range> & { basis: string } };
  for (const [skill, items] of Object.entries(src.gathering as Record<string, Record<string, Gathered>>)) {
    const f = src.fortune[skill];
    for (const [item, g] of Object.entries(items)) {
      const suffix = item.toLowerCase().replace(/:/g, '-');
      const primary = `collect.${suffix}`;
      if (!rated.has(primary)) throw new Error(`combo-sources: no rate for ${primary}`);
      const [bLo, bHi] = g.base ?? [1, 1];
      // Pristine (gemstones only): a Flawed drop is worth 80 Rough, so items x (1 + 79 x Pristine/100).
      const pristine = (k: string): Range => (g.pristine ? (g.pristine[k] as Range).map((p) => 1 + (79 * p) / 100) as Range : [1, 1]);
      const per = Object.fromEntries(BRACKET_NAMES.map((k) => {
        const [fLo, fHi] = f[k] as Range;
        const [pLo, pHi] = pristine(k);
        return [k, [r3(g.xp / (bHi * pHi * (1 + fHi / 100))), r3(g.xp / (bLo * pLo * (1 + fLo / 100)))]];
      }));
      const baseNote = g.base ? `, ${bLo === bHi ? bLo : `${bLo}-${bHi}`} items per block (${g.baseBasis ?? src.baseBasis[skill]})` : '';
      const pristineNote = g.pristine ? `; Pristine ${BRACKET_NAMES.map((k) => `${k} ${g.pristine![k]!.join('-')}`).join(', ')} (${g.pristine.basis})` : '';
      const yields: unknown[] = [{
        metric: `skills.${skill}.xp`, per,
        basis: `${g.xp} ${skill[0]!.toUpperCase()}${skill.slice(1)} XP per block${baseNote}; fortune ${BRACKET_NAMES.map((k) => `${k} ${f[k].join('-')}`).join(', ')} (${f.basis})${pristineNote}`,
      }];
      const milestone = `garden.crop_milestone.${item}`;
      const garden = skill === 'farming' && metrics.has(milestone);
      if (garden) yields.push({ metric: milestone, per: src.gardenMilestones.per, basis: src.gardenMilestones.basis });
      const areas: string[] = accessSrc.collections[item]?.areas ?? [];
      const location = garden ? 'The Garden' : areas.map((a) => accessSrc.areas[a].name).join(' or ') || undefined;
      const [verb, Verb] = VERB[skill]!;
      combos.push({
        id: `combo.${verb}.${suffix}`, name: `${Verb} ${g.name}${garden ? ' in the Garden' : ''}`,
        ...(location ? { location } : {}), primary, yields,
      });
    }
  }
  return { source: src.source, note: `Generated by npm run catalogue:build from data/sources/combo-sources.json; edit that file, not this one. ${src.note}`, combos };
}

// ---------- Mob and slayer combos (data/sources/wiki-mobs.json, combo-sources.json) ----------
const GENERATED = 'Generated by npm run catalogue:build; edit the sources, not this file.';
const wikiMobs = read<{ source: string; note: string; families: Record<string, { combatXp: Range; otherXp?: Record<string, Range>; drops: Record<string, Range> }> }>('data/sources/wiki-mobs.json');
const plural = (name: string) => (/man$/.test(name) ? name.replace(/man$/, 'men') : /(s|x|sh|ch)$/.test(name) ? `${name}es` : /[^aeiou]y$/.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`);

/** What one kill of a family gives, as yields: Combat XP, other skill XP, guaranteed drops that are collections. */
function killYields(id: string, metrics: Set<string>, times: (r: Range) => Range | Record<Bracket, Range> = (r) => r) {
  const m = wikiMobs.families[id];
  if (!m) return [];
  const page = `wiki ${id.split('.').pop()} page, Mob Drops Table`;
  const ys: { metric: string; per: Range | Record<Bracket, Range>; basis: string }[] = [];
  const xp = (skill: string, r: Range) => {
    if (metrics.has(`skills.${skill}.xp`)) ys.push({ metric: `skills.${skill}.xp`, per: times(r), basis: `${r[0] === r[1] ? r[0] : r.join('-')} ${skill[0]!.toUpperCase()}${skill.slice(1)} XP per kill (${page})` });
  };
  xp('combat', m.combatXp);
  for (const [skill, r] of Object.entries(m.otherXp ?? {})) xp(skill, r);
  for (const [item, r] of Object.entries(m.drops)) {
    if (metrics.has(`collections.${item}`)) ys.push({ metric: `collections.${item}`, per: times(r), basis: `${r[0] === r[1] ? r[0] : r.join('-')} ${item} per kill at 100% (${page})` });
  }
  return ys;
}

/** One combo per grindable bestiary family with wiki kill data: kills are the primary. */
function buildMobCombos(rates: Record<string, RateEntry[]>, tasks: Task[], families: { id: string; name: string; island: string }[]) {
  const rated = new Set(Object.values(rates).flat().map((r) => r.activity));
  const metrics = new Set(tasks.map((t) => t.requires.metric));
  const byId = new Map(families.map((f) => [f.id, f]));
  const combos = Object.keys(wikiMobs.families).filter((id) => rated.has(`combat.${id}`)).map((id) => {
    const f = byId.get(id);
    const area = accessSrc.bestiaryFamilies?.[id]?.area as string | undefined;
    // "Private Island" families (bats, creepers...) spawn all over; no single place to name.
    const location = area ? accessSrc.areas[area]?.name : f && f.island !== 'Private Island' ? f.island : undefined;
    return { id: `combo.mob.${id}`, name: `Kill ${plural(f?.name ?? id)}`, ...(location ? { location } : {}), primary: `combat.${id}`, yields: killYields(id, metrics) };
  }).filter((c) => c.yields.length);
  return { source: wikiMobs.source, note: `${GENERATED} ${wikiMobs.note}`, combos };
}

/**
 * Slayer quests: slayer XP is the primary. The Combat XP needed to spawn each boss comes from mobs,
 * so where one mob is the usual grind, its kills and drops come along: kills per slayer XP =
 * Combat XP per slayer XP / that mob's Combat XP per kill.
 */
function buildSlayerCombos(tasks: Task[]) {
  const src = read<any>('data/sources/combo-sources.json');
  const metrics = new Set(tasks.map((t) => t.requires.metric));
  const r3 = (x: number) => Number(x.toPrecision(3));
  const combos = (src.slayer as { boss: string; name: string; location: string; mob?: string; combatPerSlayerXp: Record<Bracket, Range>; basis: string }[]).map((s) => {
    const yields: unknown[] = [{ metric: 'skills.combat.xp', per: s.combatPerSlayerXp, basis: s.basis }];
    const mob = s.mob ? wikiMobs.families[s.mob] : undefined;
    if (s.mob && mob) {
      // Kills per slayer XP, per bracket: fewest kills when each gives the most XP.
      const kills = (k: Bracket): Range => [r3(s.combatPerSlayerXp[k][0] / mob.combatXp[1]), r3(s.combatPerSlayerXp[k][1] / mob.combatXp[0])];
      const perBracket = (r: Range) => Object.fromEntries(BRACKET_NAMES.map((k) => [k, [r3(kills(k)[0] * r[0]), r3(kills(k)[1] * r[1])]])) as Record<Bracket, Range>;
      const family = `bestiary.family.${s.mob}`;
      if (metrics.has(family)) yields.push({ metric: family, per: perBracket([1, 1]), basis: `kills to spawn: Combat XP per slayer XP / ${mob.combatXp[0]} Combat XP per ${s.mob.split('.').pop()} kill (wiki-mobs.json)` });
      for (const y of killYields(s.mob, metrics, perBracket)) if (y.metric !== 'skills.combat.xp') yields.push({ ...y, basis: `${y.basis}, times kills per slayer XP` });
    }
    return { id: `combo.slayer.${s.boss}`, name: s.name, location: s.location, primary: `slayer.${s.boss}`, yields };
  });
  return { source: src.slayerSource, note: `${GENERATED} ${src.slayerNote}`, combos };
}

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
    ...buildLeveling(),
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
  const rates = buildRates(Object.values(out).flat(), bestiary.families);
  mkdirSync('data/rates', { recursive: true });
  for (const [file, list] of Object.entries(rates)) {
    writeFileSync(`data/rates/${file}.json`, `[\n${list.map((r) => '  ' + JSON.stringify(r)).join(',\n')}\n]\n`);
    console.log(`  rates/${file}.json: ${list.length} activities`);
  }
  const all = Object.values(out).flat();
  const generated = { gathering: buildGatheringCombos(rates, all), mobs: buildMobCombos(rates, all, bestiary.families), slayer: buildSlayerCombos(all) };
  for (const [file, g] of Object.entries(generated)) {
    writeFileSync(`data/combos/${file}.json`, `{\n  "source": ${JSON.stringify(g.source)},\n  "note": ${JSON.stringify(g.note)},\n  "combos": [\n${g.combos.map((c) => '    ' + JSON.stringify(c)).join(',\n')}\n  ]\n}\n`);
    console.log(`  combos/${file}.json: ${g.combos.length} combos`);
  }
  writeFileSync('data/bestiary/families.json', `[\n${bestiary.families.map((f) => '  ' + JSON.stringify(f)).join(',\n')}\n]\n`);
  console.log(`  wrote data/bestiary/families.json (${bestiary.families.length} families)`);
}

main();
