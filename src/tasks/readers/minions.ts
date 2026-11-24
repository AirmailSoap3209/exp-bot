import type { Reader } from '../progress.js';
import { unknownMetric } from './util.js';

/** minions.crafted.<ID>_<tier> — 1 once that tier has been crafted. */
export const minions: Reader = (task, p) => {
  const metric = task.requires.metric;
  if (!metric.startsWith('minions.crafted.')) return unknownMetric(metric);
  if (!p.minions.available) return { kind: 'unavailable', reason: p.minions.reason };
  return { kind: 'measured', current: p.minions.value.crafted.has(metric.slice('minions.crafted.'.length)) ? 1 : 0, confidence: 'exact' };
};
