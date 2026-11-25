import { DUNGEON_CLASSES, SKILLS, SLAYER_BOSSES, type DungeonClass, type NormalizedProfile, type SkillId, type SlayerBoss } from '../../profile/types.js';
import { familyMobs } from './bestiary.js';

/**
 * The raw value of a metric right now, for measuring rates in sessions.
 * Unlike a task reading, this never substitutes "complete": it's the actual count.
 * Undefined when the profile doesn't show it.
 */
export type MetricValue = (metric: string, p: NormalizedProfile) => number | undefined;

const skills: MetricValue = (metric, p) => {
  const [, skill, field] = metric.split('.');
  if (field !== 'xp' || !SKILLS.includes(skill as SkillId) || !p.skills.available) return undefined;
  return p.skills.value[skill as SkillId].xp;
};

/** The player's own amount, so a co-op mate's gathering doesn't count toward their rate. */
const collections: MetricValue = (metric, p) => {
  if (!metric.startsWith('collections.') || !p.collections.amounts.available) return undefined;
  return p.collections.amounts.value.ownByItem[metric.slice('collections.'.length)] ?? 0;
};

const bestiary: MetricValue = (metric, p) => {
  if (!p.bestiary.available) return undefined;
  const b = p.bestiary.value;
  if (metric === 'bestiary.milestone') return b.lastClaimedMilestone;
  const mobs = metric.startsWith('bestiary.family.') ? familyMobs().get(metric.slice('bestiary.family.'.length)) : undefined;
  return mobs?.reduce((a, m) => a + (b.kills[m] ?? 0), 0);
};

const slayer: MetricValue = (metric, p) => {
  const [, boss, field, tier] = metric.split('.');
  if (!SLAYER_BOSSES.includes(boss as SlayerBoss) || !p.slayer.available) return undefined;
  const s = p.slayer.value[boss as SlayerBoss];
  if (field === 'xp' && tier === undefined) return s.xp;
  const n = field === 'kills' ? /^tier(\d)$/.exec(tier ?? '')?.[1] : undefined;
  return n ? (s.bossKills[Number(n) - 1] ?? 0) : undefined;
};

const catacombs: MetricValue = (metric, p) => {
  if (!p.catacombs.available) return undefined;
  const c = p.catacombs.value;
  const parts = metric.split('.');
  if (metric === 'catacombs.xp') return c.level.xp;
  if (parts[1] === 'classes' && parts[3] === 'xp' && DUNGEON_CLASSES.includes(parts[2] as DungeonClass)) return c.classes[parts[2] as DungeonClass].xp;
  if (parts.length === 3 && parts[1] === 'completions') return c.floorCompletions[parts[2]!] ?? 0;
  if (parts.length === 3 && parts[1] === 'master') return c.masterCompletions[parts[2]!] ?? 0;
  return undefined;
};

const hotm: MetricValue = (metric, p) => (metric === 'hotm.xp' && p.skillTree.available ? p.skillTree.value.hotmXp : undefined);
const foragingTasks: MetricValue = (metric, p) => (metric === 'hotf.xp' && p.skillTree.available ? p.skillTree.value.hotfXp : undefined);

const garden: MetricValue = (metric, p) => {
  if (!p.garden.available) return undefined;
  const g = p.garden.value;
  if (metric === 'garden.xp') return g.xp;
  if (metric === 'garden.visitors_accepted') return g.offersAccepted;
  if (metric.startsWith('garden.crop_milestone.')) return g.cropMilestones[metric.slice('garden.crop_milestone.'.length)] ?? 0;
  return undefined;
};

/**
 * Per category, like the readers. Categories with only fixed-time tasks need none. A session
 * snapshot reads every metric these cover, so it can see what else moved alongside the activity.
 */
export const METRIC_VALUES: Record<string, MetricValue> = { skills, collections, bestiary, slayer, catacombs, hotm, foraging_tasks: foragingTasks, garden };
