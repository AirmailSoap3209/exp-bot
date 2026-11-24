import type { Reader } from '../progress.js';
import { unknownMetric } from './util.js';

/** collections.<ITEM> — co-op total of that item; tier completion from unlocked tiers. */
export const collections: Reader = (task, p) => {
  const metric = task.requires.metric;
  if (!metric.startsWith('collections.') || !task.tier) return unknownMetric(metric);
  const item = metric.slice('collections.'.length);
  const { unlockedTiers, amounts } = p.collections;

  // Unlocked tiers stay visible with the Collections API off, so completion is still provable.
  if (unlockedTiers.available && unlockedTiers.value.has(`${item}_${task.tier}`)) {
    return { kind: 'measured', current: task.requires.amount, confidence: 'exact', complete: true };
  }
  if (!amounts.available) {
    return { kind: 'unavailable', reason: `${amounts.reason}; tier not unlocked yet, amount unknown` };
  }
  const a = amounts.value;
  return {
    kind: 'measured',
    current: a.byItem[item] ?? 0,
    // A hidden co-op member's share is missing, so the true total can only be higher.
    confidence: a.hiddenMembers > 0 ? 'lowerBound' : 'exact',
  };
};
