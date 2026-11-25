import type { NormalizedProfile, Section } from '../../profile/types.js';
import type { Reader, Reading } from '../progress.js';
import { familyMobs } from './bestiary.js';
import { unknownMetric } from './util.js';

/** A number read straight from one profile section. */
function fromSection<T>(s: Section<T>, read: (v: T) => number | undefined, metric: string): Reading {
  if (!s.available) return { kind: 'unavailable', reason: s.reason };
  const v = read(s.value);
  return v === undefined ? unknownMetric(metric) : { kind: 'measured', current: v, confidence: 'exact' };
}

/** hotm.xp (skill_tree.experience.mining), hotm.nucleus_runs (leveling.completions.NUCLEUS_RUNS) */
export const hotm: Reader = (task, p) => {
  const m = task.requires.metric;
  if (m === 'hotm.xp') return fromSection(p.skillTree, (v) => v.hotmXp, m);
  if (m === 'hotm.nucleus_runs') return fromSection(p.completions, (v) => v.NUCLEUS_RUNS ?? 0, m);
  return unknownMetric(m);
};

/** hotf.xp (skill_tree.experience.foraging) */
export const foragingTasks: Reader = (task, p) => {
  const m = task.requires.metric;
  return m === 'hotf.xp' ? fromSection(p.skillTree, (v) => v.hotfXp, m) : unknownMetric(m);
};

/** garden.jacob_gold.<CROP> (1 once a gold or better medal is held), garden.anita.<perk> (tier) */
export const garden: Reader = (task, p) => {
  const m = task.requires.metric;
  if (m.startsWith('garden.jacob_gold.')) return fromSection(p.jacob, (v) => (v.goldCrops.has(m.slice('garden.jacob_gold.'.length)) ? 1 : 0), m);
  if (m === 'garden.anita.double_drops') return fromSection(p.jacob, (v) => v.doubleDrops, m);
  if (m === 'garden.anita.farming_level_cap') return fromSection(p.jacob, (v) => v.farmingLevelCap, m);
  return unknownMetric(m);
};

/** trophy.<fish>_<tier>: catches of that fish at that tier. */
export const trophyFishing: Reader = (task, p) => {
  const m = task.requires.metric;
  if (!m.startsWith('trophy.')) return unknownMetric(m);
  return fromSection(p.trophyFish, (v) => v[m.slice('trophy.'.length)] ?? 0, m);
};

/** rift.timecharms: secured Timecharms (rift.gallery.secured_trophies). */
export const rift: Reader = (task, p) => {
  const m = task.requires.metric;
  return m === 'rift.timecharms' ? fromSection(p.rift, (v) => v.timecharms, m) : unknownMetric(m);
};

/** Bestiary families of the Mythological Creatures island, from families.json. */
let mythMobs: string[] | undefined;
const mythologicalMobs = () =>
  (mythMobs ??= [...familyMobs()].filter(([id]) => id.startsWith('mythological_creatures.')).flatMap(([, mobs]) => mobs));

/**
 * mythological.kills: bestiary kills summed over the Mythological Creatures families.
 * Approximate, like bestiary families: NEU's mob lists can miss a variant.
 */
export const mythological: Reader = (task, p: NormalizedProfile) => {
  const m = task.requires.metric;
  if (m !== 'mythological.kills') return unknownMetric(m);
  if (!p.bestiary.available) return { kind: 'unavailable', reason: p.bestiary.reason };
  const kills = p.bestiary.value.kills;
  return { kind: 'measured', current: mythologicalMobs().reduce((a, mob) => a + (kills[mob] ?? 0), 0), confidence: 'approx' };
};
