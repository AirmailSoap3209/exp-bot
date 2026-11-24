import type { Reader } from '../progress.js';
import { unknownMetric } from './util.js';

/** fairySouls.exchanges */
export const fairySouls: Reader = (task, p) => {
  if (task.requires.metric !== 'fairySouls.exchanges') return unknownMetric(task.requires.metric);
  if (!p.fairySouls.available) return { kind: 'unavailable', reason: p.fairySouls.reason };
  return { kind: 'measured', current: p.fairySouls.value.exchanges, confidence: 'exact' };
};
