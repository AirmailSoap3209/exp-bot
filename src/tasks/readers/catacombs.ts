import { DUNGEON_CLASSES, type DungeonClass } from '../../profile/types.js';
import type { Reader } from '../progress.js';
import { unknownMetric } from './util.js';

/** catacombs.xp, catacombs.classes.<class>.xp, catacombs.completions.<floor>, catacombs.master.<floor> */
export const catacombs: Reader = (task, p) => {
  const metric = task.requires.metric;
  if (!p.catacombs.available) return { kind: 'unavailable', reason: p.catacombs.reason };
  const c = p.catacombs.value;
  const parts = metric.split('.');
  if (metric === 'catacombs.xp') return { kind: 'measured', current: c.level.xp, confidence: 'exact' };
  if (parts[1] === 'classes' && parts[3] === 'xp' && DUNGEON_CLASSES.includes(parts[2] as DungeonClass)) {
    return { kind: 'measured', current: c.classes[parts[2] as DungeonClass].xp, confidence: 'exact' };
  }
  if (parts.length === 3 && (parts[1] === 'completions' || parts[1] === 'master')) {
    const map = parts[1] === 'completions' ? c.floorCompletions : c.masterCompletions;
    return { kind: 'measured', current: map[parts[2]!] ?? 0, confidence: 'exact' };
  }
  return unknownMetric(metric);
};
