import type { RawProfile } from '../hypixel/client.js';
import { normalizeUuid } from '../hypixel/client.js';
import { catacombsLevel, levelFromCumulative, slayerLevel } from './levels.js';
import {
  DUNGEON_CLASSES,
  SKILLS,
  SLAYER_BOSSES,
  type CatacombsProgress,
  type NormalizedProfile,
  type Section,
  type SkillId,
  type SkillProgress,
  type SlayerProgress,
} from './types.js';

/** Shape of /v2/resources/skyblock/skills that the normalizer uses. */
export interface SkillsResource {
  skills: Record<string, { maxLevel: number; levels: { level: number; totalExpRequired: number }[] }>;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const ok = <T>(value: T): Section<T> => ({ available: true, value });
const missing = <T>(reason: string): Section<T> => ({ available: false, reason });

function at(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function numberMap(v: Obj): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === 'number') out[k] = x;
  return out;
}

function stringSet(v: unknown): Set<string> | undefined {
  return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === 'string')) : undefined;
}

/** Members still in the co-op (left members keep their data but carry a deletion_notice). */
function activeMembers(profile: RawProfile): Obj[] {
  return Object.values(profile.members).filter((m) => isObj(m) && !at(m, 'profile.deletion_notice')) as Obj[];
}

function readLeveling(m: Obj): NormalizedProfile['leveling'] {
  const experience = num(at(m, 'leveling.experience'));
  const tasks = stringSet(at(m, 'leveling.completed_tasks'));
  return {
    experience,
    level: Math.floor(experience / 100),
    completedTasks: tasks
      ? ok(tasks)
      : experience === 0
        ? ok(new Set())
        : missing('No completed task list on this profile'),
  };
}

function skillCap(skill: SkillId, m: Obj, resourceMax: number): { cap: number; source: SkillProgress['capSource'] } {
  if (skill === 'farming') {
    // The perks object only lists farming_level_cap once one has been bought from Anita.
    const perks = at(m, 'jacobs_contest.perks');
    if (isObj(perks)) return { cap: Math.min(50 + num(perks.farming_level_cap), resourceMax), source: 'profile' };
  }
  if (skill === 'foraging') {
    const extra = at(m, 'player_data.experience.SKILL_FORAGING_extra_level_cap');
    if (typeof extra === 'number') return { cap: Math.min(50 + extra, resourceMax), source: 'profile' };
  }
  return { cap: resourceMax, source: 'resource' };
}

function readSkills(m: Obj, resource: SkillsResource): NormalizedProfile['skills'] {
  const exp = at(m, 'player_data.experience');
  if (!isObj(exp)) return missing('Skills API is off');
  // An empty object is what a hidden Skills API and a brand-new profile both look like.
  if (!Object.keys(exp).some((k) => k.startsWith('SKILL_') && !k.endsWith('_extra_level_cap'))) {
    return missing('No skill XP visible (Skills API off, or no skill XP yet)');
  }
  const out = {} as Record<SkillId, SkillProgress>;
  for (const skill of SKILLS) {
    const table = resource.skills[skill.toUpperCase()];
    if (!table) throw new Error(`Skills resource has no ${skill.toUpperCase()} table`);
    const cumulative = [...table.levels].sort((a, b) => a.level - b.level).map((l) => l.totalExpRequired);
    const { cap, source } = skillCap(skill, m, table.maxLevel);
    const lv = levelFromCumulative(num(exp[`SKILL_${skill.toUpperCase()}`]), cumulative, cap);
    out[skill] = { ...lv, capSource: source };
  }
  return ok(out);
}

function readCollections(m: Obj, profile: RawProfile): NormalizedProfile['collections'] {
  const tiers = stringSet(at(m, 'player_data.unlocked_coll_tiers'));
  const unlockedTiers = tiers ? ok(tiers) : missing<Set<string>>('No unlocked collection tiers on this profile');

  if (!isObj(m.collection)) {
    // Unlocked tiers prove collections exist, so a missing amount map means the API setting is off.
    const reason = tiers?.size ? 'Collections API is off' : 'No collection data (Collections API off, or nothing collected yet)';
    return { unlockedTiers, amounts: missing(reason) };
  }
  // Collection tiers count the whole co-op's total, so sum every active member we can see.
  const members = activeMembers(profile);
  const byItem: Record<string, number> = {};
  let hidden = 0;
  for (const member of members) {
    if (!isObj(member.collection)) {
      hidden++;
      continue;
    }
    for (const [item, amount] of Object.entries(numberMap(member.collection))) {
      byItem[item] = (byItem[item] ?? 0) + amount;
    }
  }
  return {
    unlockedTiers,
    amounts: ok({ byItem, activeMembers: members.length, hiddenMembers: hidden, ownByItem: numberMap(m.collection) }),
  };
}

function readBestiary(m: Obj): NormalizedProfile['bestiary'] {
  const kills = at(m, 'bestiary.kills');
  if (!isObj(kills)) return missing('No bestiary data on this profile');
  return ok({
    kills: numberMap(kills), // drops the "last_killed_mob" string entry
    lastClaimedMilestone: num(at(m, 'bestiary.milestone.last_claimed_milestone')),
  });
}

function readSlayer(m: Obj): NormalizedProfile['slayer'] {
  const bosses = at(m, 'slayer.slayer_bosses');
  if (!isObj(bosses)) return missing('No slayer data on this profile');
  const out = {} as Record<(typeof SLAYER_BOSSES)[number], SlayerProgress>;
  for (const boss of SLAYER_BOSSES) {
    const b = isObj(bosses[boss]) ? (bosses[boss] as Obj) : {};
    const claimed = isObj(b.claimed_levels) ? Object.keys(b.claimed_levels) : [];
    const claimedLevel = Math.max(0, ...claimed.map((k) => Number(/^level_(\d+)/.exec(k)?.[1] ?? 0)));
    const bossKills: number[] = [];
    for (let tier = 0; tier < 5; tier++) bossKills.push(num(b[`boss_kills_tier_${tier}`]));
    out[boss] = { ...slayerLevel(boss, num(b.xp)), claimedLevel, bossKills };
  }
  return ok(out);
}

function readCatacombs(m: Obj): NormalizedProfile['catacombs'] {
  const dungeons = at(m, 'dungeons');
  if (!isObj(dungeons)) return missing('No dungeon data on this profile');
  const cata = at(dungeons, 'dungeon_types.catacombs');
  const master = at(dungeons, 'dungeon_types.master_catacombs.tier_completions');
  const completions = (v: unknown) => {
    const map = isObj(v) ? numberMap(v) : {};
    delete map.total;
    return map;
  };
  const classes = {} as CatacombsProgress['classes'];
  for (const c of DUNGEON_CLASSES) classes[c] = catacombsLevel(num(at(dungeons, `player_classes.${c}.experience`)));
  return ok({
    level: catacombsLevel(num(at(cata, 'experience'))),
    classes,
    floorCompletions: completions(at(cata, 'tier_completions')),
    masterCompletions: completions(master),
  });
}

function readFairySouls(m: Obj): NormalizedProfile['fairySouls'] {
  const fs = m.fairy_soul;
  if (!isObj(fs)) return missing('No fairy soul data on this profile');
  return ok({ collected: num(fs.total_collected), exchanges: num(fs.fairy_exchanges) });
}

function readMinions(m: Obj): NormalizedProfile['minions'] {
  const crafted = stringSet(at(m, 'player_data.crafted_generators'));
  return crafted ? ok({ crafted }) : missing('No crafted minion list on this profile');
}

export function normalizeProfile(
  profile: RawProfile,
  uuid: string,
  skillsResource: SkillsResource,
  fetchedAt: number,
): NormalizedProfile {
  const id = normalizeUuid(uuid);
  const m = profile.members[id];
  if (!isObj(m)) throw new Error(`Player ${id} is not a member of profile ${profile.profile_id}`);
  return {
    uuid: id,
    profileId: profile.profile_id,
    cuteName: profile.cute_name ?? profile.profile_id,
    selected: profile.selected === true,
    gameMode: profile.game_mode ?? 'normal',
    fetchedAt,
    leveling: readLeveling(m),
    skills: readSkills(m, skillsResource),
    collections: readCollections(m, profile),
    bestiary: readBestiary(m),
    slayer: readSlayer(m),
    catacombs: readCatacombs(m),
    fairySouls: readFairySouls(m),
    minions: readMinions(m),
    skillTree: readSkillTree(m),
    completions: readCompletions(m),
    jacob: readJacob(m),
    trophyFish: readTrophyFish(m),
    rift: readRift(m),
  };
}

function readSkillTree(m: Obj): NormalizedProfile['skillTree'] {
  const xp = at(m, 'skill_tree.experience');
  if (!isObj(xp)) return missing('No Heart of the Mountain or Forest data on this profile');
  return ok({ hotmXp: num(xp.mining), hotfXp: num(xp.foraging) });
}

function readCompletions(m: Obj): NormalizedProfile['completions'] {
  const c = at(m, 'leveling.completions');
  return isObj(c) ? ok(numberMap(c)) : missing('No leveling task counters on this profile');
}

function readJacob(m: Obj): NormalizedProfile['jacob'] {
  const j = at(m, 'jacobs_contest');
  if (!isObj(j)) return missing("No Jacob's Farming Contest data on this profile");
  const gold = new Set<string>();
  for (const b of ['gold', 'platinum', 'diamond']) for (const c of stringSet(at(j, `unique_brackets.${b}`)) ?? []) gold.add(c);
  return ok({ goldCrops: gold, doubleDrops: num(at(j, 'perks.double_drops')), farmingLevelCap: num(at(j, 'perks.farming_level_cap')) });
}

function readTrophyFish(m: Obj): NormalizedProfile['trophyFish'] {
  const t = m.trophy_fish;
  return isObj(t) ? ok(numberMap(t)) : missing('No trophy fish data on this profile');
}

function readRift(m: Obj): NormalizedProfile['rift'] {
  const r = m.rift;
  if (!isObj(r)) return missing('No Rift data on this profile');
  const secured = at(r, 'gallery.secured_trophies');
  return ok({ timecharms: Array.isArray(secured) ? secured.length : 0 });
}

/** Picks a profile by cute name or ID, or the player's selected profile when none is given. */
export function pickProfile(profiles: RawProfile[] | null, query?: string): RawProfile | undefined {
  if (!profiles?.length) return undefined;
  if (!query) return profiles.find((p) => p.selected) ?? profiles[0];
  const q = query.toLowerCase().replace(/-/g, '');
  return profiles.find(
    (p) => p.cute_name?.toLowerCase() === q || p.profile_id.replace(/-/g, '').toLowerCase() === q,
  );
}
