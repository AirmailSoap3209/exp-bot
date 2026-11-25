import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { targetEmbed, targetLines } from '../../src/commands/targetPlan.js';
import { loadRates } from '../../src/estimate/rates.js';
import type { ProfilesResponse } from '../../src/hypixel/client.js';
import { planTarget, xpToLevel } from '../../src/optimizer/target.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import type { NormalizedProfile } from '../../src/profile/types.js';
import { defaultExcluded, loadCatalogue } from '../../src/tasks/catalogue.js';
import { evaluateProgress, type TaskProgress } from '../../src/tasks/progress.js';
import type { Task } from '../../src/tasks/types.js';

const book = loadRates();
const ctx = { book };
/** Fixed-time tasks don't look at the profile. */
const noProfile = {} as NormalizedProfile;

/** A fixed-time task taking exactly `minutes`, not started. */
function ft(id: string, xp: number, minutes: number, extra: Partial<Task> = {}, current = 0): TaskProgress {
  const task: Task = {
    id, category: 'x', name: id, description: id, xp, requires: { metric: `m.${id}`, amount: 1 }, prerequisites: [],
    activity: null, minutes: [minutes, minutes], monetary: false, tracking: 'api', source: 'test', ...extra,
  };
  return { task, status: 'verified_incomplete', current, required: 1, remaining: Math.max(0, 1 - current), likelyComplete: false };
}
const order = (plan: ReturnType<typeof planTarget>) => plan.picks.map((s) => s.progress.task.id);

describe('xpToLevel', () => {
  it('uses total XP: 100 per level', () => {
    expect(xpToLevel(209, 20_850)).toBe(50);
    expect(xpToLevel(208, 20_850)).toBe(-50);
    expect(xpToLevel(1, 0)).toBe(100);
  });
});

describe('planTarget', () => {
  it('picks by XP per minute and stops once the target is met', () => {
    const plan = planTarget([ft('slow', 10, 10), ft('fast', 3, 1), ft('mid', 6, 3)], noProfile, ctx, 8);
    expect(order(plan)).toEqual(['fast', 'mid']);
    expect(plan).toMatchObject({ xp: 9, minutes: [4, 4], reached: true, trimmed: 0 });
    expect(plan.picks.map((s) => s.total.xp)).toEqual([3, 9]);
  });

  it('finish step: takes one quick task that covers the rest over a slow best-ratio task', () => {
    const plan = planTarget([ft('big', 100, 20), ft('enough', 10, 5)], noProfile, ctx, 10);
    expect(order(plan)).toEqual(['enough']);
  });

  it('trims steps the target does not need, but never a prerequisite of a later step', () => {
    const plan = planTarget(
      [
        ft('a1', 1, 10, { group: 'a', tier: 1 }),
        ft('a2', 50, 1, { group: 'a', tier: 2, prerequisites: ['a1'] }),
        ft('b', 5, 1),
        ft('c', 30, 2),
      ],
      noProfile, ctx, 40,
    );
    // Greedy takes c, b, a1, a2 (86 XP). c and b aren't needed; a1 is slow and
    // looks spare, but a2 needs it.
    expect(order(plan)).toEqual(['a1', 'a2']);
    expect(plan).toMatchObject({ xp: 51, trimmed: 2, reached: true });
  });

  it('counts every completed task once, including dependents a step finishes for free', () => {
    const plan = planTarget(
      [ft('a', 5, 1), ft('met', 7, 1, { prerequisites: ['a'] }, 1), ft('b', 1, 100)],
      noProfile, ctx, 12,
    );
    expect(order(plan)).toEqual(['a']);
    expect(plan.picks[0]!.completed.map((t) => t.id)).toEqual(['a', 'met']);
    expect(plan.xp).toBe(12);
  });

  it('gives excluded and monetary tasks no XP and never picks them', () => {
    const plan = planTarget(
      [ft('ex', 50, 1, { group: 'g' }), ft('money', 50, 1, { monetary: true }), ft('ok', 2, 1)],
      noProfile, ctx, 10, { excludedSources: new Set(['g']) },
    );
    expect(order(plan)).toEqual(['ok']);
    expect(plan).toMatchObject({ xp: 2, reached: false, capped: false });
  });

  it('stops at maxPicks and says so', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ft(`t${i}`, 1, 1));
    expect(planTarget(tasks, noProfile, ctx, 10, { maxPicks: 3 })).toMatchObject({ xp: 3, reached: false, capped: true });
  });
});

describe('planTarget on a real profile', () => {
  const catalogue = loadCatalogue();
  const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
  const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>('../fixtures/profiles-floor7sweat.json');
  const lime = normalizeProfile(pickProfile(response.profiles, 'lime')!, uuid, read<SkillsResource>('../fixtures/resource-skills.json'), 0);
  const progress = evaluateProgress(catalogue, lime).progress;
  const ex = { excluded: new Set(defaultExcluded(catalogue)) };
  const plan = planTarget(progress, lime, ctx, 1000, ex);

  it('reaches the target with a valid plan: no repeats, prerequisites first, totals add up', () => {
    expect(plan.reached).toBe(true);
    expect(plan.xp).toBeGreaterThanOrEqual(1000);
    const ids = plan.picks.flatMap((s) => s.completed.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    const P = new Map(progress.map((p) => [p.task.id, p]));
    const doneBefore = new Set(progress.filter((p) => p.status === 'verified_complete' || p.status === 'ticked' || p.likelyComplete).map((p) => p.task.id));
    for (const s of plan.picks) {
      for (const pre of s.progress.task.prerequisites) expect(doneBefore.has(pre), `${s.progress.task.id} needs ${pre}`).toBe(true);
      for (const t of s.completed) doneBefore.add(t.id);
      expect(P.get(s.progress.task.id)!.task.monetary).toBe(false);
      expect(s.progress.task.category).not.toBe('minions'); // excluded by default
    }
    expect(plan.picks.reduce((n, s) => n + s.xp, 0)).toBe(plan.xp);
    expect(plan.picks.at(-1)!.total.minutes).toEqual(plan.minutes);
  });

  it('renders an embed that fits Discord limits', () => {
    const json = targetEmbed('Floor7Sweat', lime, plan, 0, { ask: { kind: 'level', level: 218 }, now: 0 }).toJSON();
    expect(json.description).toMatch(/^\*\*Target Level 218 \(\+1,000 XP\)\*\* · level 208 → 21\d/);
    expect(json.description!.length).toBeLessThanOrEqual(4096);
    expect(json.footer?.text).toContain('page 1/');
    expect(targetLines(plan)[0]).toMatch(/^\*\*1\. .+\*\* · \+\d+ XP · /);
  });
});
