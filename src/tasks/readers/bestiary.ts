import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../catalogue.js';
import type { Reader } from '../progress.js';
import { unknownMetric } from './util.js';

interface Family { id: string; mobs: string[] }

let families: Map<string, string[]> | undefined;
function familyMobs(): Map<string, string[]> {
  families ??= new Map(
    (JSON.parse(readFileSync(join(DATA_DIR, 'bestiary', 'families.json'), 'utf8')) as Family[]).map((f) => [f.id, f.mobs]),
  );
  return families;
}

/**
 * bestiary.family.<id> — kills summed over the family's mob keys.
 *   Approximate: the family list (NEU) undercounts real tiers by a few percent.
 * bestiary.milestone — exact, straight from the API.
 */
export const bestiary: Reader = (task, p) => {
  const metric = task.requires.metric;
  if (!p.bestiary.available) return { kind: 'unavailable', reason: p.bestiary.reason };
  const b = p.bestiary.value;
  if (metric === 'bestiary.milestone') return { kind: 'measured', current: b.lastClaimedMilestone, confidence: 'exact' };
  if (!metric.startsWith('bestiary.family.')) return unknownMetric(metric);
  const mobs = familyMobs().get(metric.slice('bestiary.family.'.length));
  if (!mobs) return unknownMetric(metric);
  return { kind: 'measured', current: mobs.reduce((a, m) => a + (b.kills[m] ?? 0), 0), confidence: 'approx' };
};
