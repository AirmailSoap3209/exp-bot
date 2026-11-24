import { SLAYER_BOSSES, type SlayerBoss } from '../../profile/types.js';
import type { Reader } from '../progress.js';
import { unknownMetric } from './util.js';

/** slayer.<boss>.xp and slayer.<boss>.kills.tier<N> */
export const slayer: Reader = (task, p) => {
  const metric = task.requires.metric;
  const [, boss, field, tierPart] = metric.split('.');
  if (!SLAYER_BOSSES.includes(boss as SlayerBoss)) return unknownMetric(metric);
  if (!p.slayer.available) return { kind: 'unavailable', reason: p.slayer.reason };
  const s = p.slayer.value[boss as SlayerBoss];
  if (field === 'xp' && tierPart === undefined) return { kind: 'measured', current: s.xp, confidence: 'exact' };
  const tier = field === 'kills' ? /^tier(\d)$/.exec(tierPart ?? '')?.[1] : undefined;
  if (!tier) return unknownMetric(metric);
  return { kind: 'measured', current: s.bossKills[Number(tier) - 1] ?? 0, confidence: 'exact' };
};
