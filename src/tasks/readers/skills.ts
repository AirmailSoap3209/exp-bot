import type { Reader } from '../progress.js';
import { SKILLS, type SkillId } from '../../profile/types.js';
import { unknownMetric } from './util.js';

/** skills.<skill>.xp */
export const skills: Reader = (task, p) => {
  const [, skill, field] = task.requires.metric.split('.');
  if (field !== 'xp' || !SKILLS.includes(skill as SkillId)) return unknownMetric(task.requires.metric);
  if (!p.skills.available) return { kind: 'unavailable', reason: p.skills.reason };
  const s = p.skills.value[skill as SkillId];
  const tier = task.tier ?? 0;
  return {
    kind: 'measured',
    current: s.xp,
    confidence: 'exact',
    // Levels above the cap don't count even with enough XP.
    complete: s.level >= tier,
    blocked: tier > s.maxLevel ? `${skill} level cap is ${s.maxLevel}` : undefined,
  };
};
