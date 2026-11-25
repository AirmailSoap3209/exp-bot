import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRates } from '../../src/estimate/rates.js';
import type { ProfilesResponse } from '../../src/hypixel/client.js';
import { PlanState } from '../../src/optimizer/plan.js';
import { rankTasks } from '../../src/optimizer/rank.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import { defaultExcluded, loadCatalogue } from '../../src/tasks/catalogue.js';
import { evaluateProgress, type Status, type TaskProgress } from '../../src/tasks/progress.js';
import type { Task } from '../../src/tasks/types.js';

/** A minimal task and its progress; `current` null means the API had no number. */
function tp(
  id: string,
  metric: string,
  amount: number,
  current: number | null,
  extra: Partial<Task> & { status?: Status; blocked?: string } = {},
): TaskProgress {
  const { status, blocked, ...task } = extra;
  const t: Task = {
    id, category: 'x', name: id, description: id, xp: 1, requires: { metric, amount }, prerequisites: [],
    activity: 'a', monetary: false, tracking: 'api', source: 'test', ...task,
  };
  const done = current !== null && current >= amount;
  return {
    task: t,
    status: status ?? (done ? 'verified_complete' : 'verified_incomplete'),
    current,
    required: amount,
    remaining: current === null ? null : Math.max(0, amount - current),
    likelyComplete: false,
    blocked,
  };
}
const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);
const candIds = (s: PlanState, ex = {}) => s.candidates(ex).map((p) => p.task.id).sort();

describe('PlanState', () => {
  it('completes each task once, even when one step finishes several', () => {
    const s = new PlanState([
      tp('wheat7', 'wheat', 100, 95, { group: 'wheat', tier: 7 }),
      tp('farm31', 'farming', 100, 90, { group: 'farming', tier: 31 }),
      tp('other', 'other', 1, 0),
    ]);
    const r = s.apply({ wheat: 10, farming: 10 });
    expect(ids(r.newlyCompleted)).toEqual(['wheat7', 'farm31']);
    expect(r.metricChanges).toEqual([{ metric: 'wheat', from: 95, to: 105 }, { metric: 'farming', from: 90, to: 100 }]);
    expect(s.apply({ wheat: 50, farming: 50 }).newlyCompleted).toEqual([]);
    expect([...s.completedTaskIds].sort()).toEqual(['farm31', 'wheat7']);
    expect(s.isComplete('other')).toBe(false);
  });

  it('starts with done tasks complete: verified, ticked, and estimates that say done', () => {
    const s = new PlanState([
      tp('a', 'm', 1, 1),
      tp('b', 'n', 5, null, { status: 'ticked' }),
      { ...tp('c', 'o', 5, 6, { status: 'estimated' }), likelyComplete: true },
      tp('d', 'p', 5, 4, { status: 'estimated' }),
    ]);
    expect([...s.completedTaskIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('completes tiers in order and unlocks tasks that depend on them', () => {
    const s = new PlanState([
      tp('wheat7', 'wheat', 100, 50, { group: 'wheat', tier: 7 }),
      tp('wheat8', 'wheat', 200, 50, { group: 'wheat', tier: 8, prerequisites: ['wheat7'] }),
      tp('wheat9', 'wheat', 500, 50, { group: 'wheat', tier: 9, prerequisites: ['wheat8'] }),
      tp('minion', 'minion.wheat', 1, 0, { prerequisites: ['wheat7'] }),
    ]);
    expect(candIds(s)).toEqual(['wheat7']);
    const r = s.apply({ wheat: 200 });
    expect(ids(r.newlyCompleted)).toEqual(['wheat7', 'wheat8']);
    expect(candIds(s)).toEqual(['minion', 'wheat9']);
    expect(s.remainingFor(s.candidates().find((p) => p.task.id === 'wheat9')!.task)).toBe(250);
  });

  it('completes a task that was already met the moment its prerequisite completes', () => {
    const s = new PlanState([
      tp('a', 'm', 10, 0),
      tp('b', 'n', 5, 5, { prerequisites: ['a'], status: 'verified_incomplete' }),
      tp('c', 'o', 1, 1, { prerequisites: ['b'], status: 'verified_incomplete' }),
    ]);
    expect(ids(s.apply({ m: 10 }).newlyCompleted)).toEqual(['a', 'b', 'c']);
  });

  it('never completes unavailable or blocked tasks, or anything behind them', () => {
    const s = new PlanState([
      tp('cap', 'skill', 100, 50, { blocked: 'above the cap' }),
      tp('nodata', 'coll', 100, null, { status: 'unavailable' }),
      tp('after', 'x', 1, 0, { prerequisites: ['nodata'] }),
    ]);
    expect(s.apply({ skill: 1000, coll: 1000, x: 5 }).newlyCompleted).toEqual([]);
    expect(candIds(s)).toEqual([]);
  });

  it('lets excluded tasks complete and unlock dependents, but never offers them', () => {
    const s = new PlanState([
      tp('wheat7', 'wheat', 100, 0, { group: 'collections.wheat', tier: 7 }),
      tp('minion', 'minion.wheat', 1, 0, { category: 'minions', prerequisites: ['wheat7'] }),
    ]);
    const ex = { excludedSources: new Set(['collections.wheat']) };
    expect(candIds(s, ex)).toEqual([]);
    expect(ids(s.apply({ wheat: 100 }).newlyCompleted)).toEqual(['wheat7']);
    expect(candIds(s, ex)).toEqual(['minion']);
    expect(candIds(s, { excluded: new Set(['minions']) })).toEqual([]);
  });

  it('terminates on a prerequisite cycle without completing it', () => {
    const s = new PlanState([tp('a', 'm', 1, 0, { prerequisites: ['b'] }), tp('b', 'm', 1, 0, { prerequisites: ['a'] })]);
    expect(s.apply({ m: 5 }).newlyCompleted).toEqual([]);
  });

  it('keeps original progress until a metric moves, then reports the simulated value', () => {
    const orig = tp('a', 'm', 100, null);
    const s = new PlanState([orig]);
    expect(s.progressFor('a')).toBe(orig);
    expect(s.remainingFor(orig.task)).toBe(100); // unknown counts from 0
    s.apply({ m: 30 });
    expect(s.progressFor('a')).toMatchObject({ current: 30, remaining: 70 });
  });

  it('applyTask adds exactly what is left, and completes an already-met task without moving anything', () => {
    const s = new PlanState([tp('a', 'm', 100, 40), tp('b', 'n', 5, 5, { prerequisites: ['a'], status: 'verified_incomplete' })]);
    const r = s.applyTask('a');
    expect(r.metricChanges).toEqual([{ metric: 'm', from: 40, to: 100 }]);
    expect(ids(r.newlyCompleted)).toEqual(['a', 'b']);
    expect(s.applyTask('a')).toEqual({ newlyCompleted: [], metricChanges: [] });

    const t = new PlanState([tp('c', 'o', 5, 5, { status: 'verified_incomplete' })]);
    expect(t.applyTask('c')).toEqual({ newlyCompleted: [t.progressFor('c')!.task], metricChanges: [] });
  });

  it('clones independently', () => {
    const s = new PlanState([tp('a', 'm', 10, 0), tp('b', 'm', 20, 0, { prerequisites: ['a'] })]);
    const c = s.clone();
    c.apply({ m: 20 });
    expect([...c.completedTaskIds].sort()).toEqual(['a', 'b']);
    expect(s.completedTaskIds.size).toBe(0);
    expect(s.value('m')).toBe(0);
    expect(s.progressFor('a')!.current).toBe(0);
  });
});

describe('PlanState on real profiles', () => {
  const catalogue = loadCatalogue();
  const book = loadRates();
  const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
  const skills = read<SkillsResource>('../fixtures/resource-skills.json');
  const cases: [string, string | undefined][] = [['floor7sweat', 'lime'], ['floor7sweat', 'pineapple'], ['dik9', undefined], ['ducksterr_', undefined]];

  it.each(cases)('offers exactly what /xp optimize ranks (%s %s)', (player, name) => {
    const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>(`../fixtures/profiles-${player}.json`);
    const profile = normalizeProfile(pickProfile(response.profiles, name)!, uuid, skills, 0);
    const progress = evaluateProgress(catalogue, profile).progress;
    const ex = { excluded: new Set(defaultExcluded(catalogue)) };
    const ranked = rankTasks(progress, profile, { book }, { ...ex, limit: Number.MAX_SAFE_INTEGER });
    expect(ranked.dropped.noRate).toBe(0);
    expect(candIds(new PlanState(progress), ex)).toEqual(ranked.ranked.map((r) => r.progress.task.id).sort());
  });

  it('doing the top task completes it and offers its next tier', () => {
    const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>('../fixtures/profiles-floor7sweat.json');
    const profile = normalizeProfile(pickProfile(response.profiles, 'lime')!, uuid, skills, 0);
    const progress = evaluateProgress(catalogue, profile).progress;
    const top = rankTasks(progress, profile, { book }).ranked[0]!.progress.task;
    const next = catalogue.tasks.find((t) => t.prerequisites.includes(top.id) && t.group === top.group);
    const s = new PlanState(progress);
    expect(ids(s.applyTask(top.id).newlyCompleted)).toContain(top.id);
    expect(s.candidates().some((p) => p.task.id === top.id)).toBe(false);
    if (next) expect(s.candidates().some((p) => p.task.id === next.id)).toBe(true);
  });
});

describe('PlanState helpers for combos', () => {
  it('nextOpen gives the lowest open, allowed task on a metric', () => {
    const s = new PlanState([
      tp('t1', 'm', 10, 10), tp('t2', 'm', 20, 10, { prerequisites: ['t1'] }), tp('t3', 'm', 30, 10, { prerequisites: ['t2'] }),
      tp('x', 'n', 5, 0, { group: 'gx' }),
    ]);
    expect(s.nextOpen('m')?.task.id).toBe('t2');
    expect(s.nextOpen('n', { excludedSources: new Set(['gx']) })).toBeUndefined();
    expect(s.nextOpen('nope')).toBeUndefined();
  });

  it('tryApply reports what apply would do and changes nothing', () => {
    const s = new PlanState([tp('a', 'm', 10, 0), tp('b', 'n', 5, 0, { prerequisites: ['a'] })]);
    const r = s.tryApply({ m: 10, n: 5 });
    expect(ids(r.newlyCompleted)).toEqual(['a', 'b']);
    expect(s.completedTaskIds.size).toBe(0);
    expect(s.value('m')).toBe(0);
    expect(s.value('n')).toBe(0);
    expect(s.progressFor('a')!.current).toBe(0);
    expect(ids(s.apply({ m: 10, n: 5 }).newlyCompleted)).toEqual(['a', 'b']);
  });
});
