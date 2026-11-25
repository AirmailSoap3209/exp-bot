import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatEntry } from '../../src/commands/optimize.js';
import { targetLines } from '../../src/commands/targetPlan.js';
import { loadCombos, type Combo } from '../../src/combos/combos.js';
import { combosFor, scoreCombo } from '../../src/combos/score.js';
import { loadRates, type RateBook } from '../../src/estimate/rates.js';
import type { RateEntry } from '../../src/estimate/types.js';
import type { ProfilesResponse } from '../../src/hypixel/client.js';
import { comboEntry, comboView, rankWithCombos } from '../../src/optimizer/combined.js';
import { PlanState } from '../../src/optimizer/plan.js';
import { planTarget } from '../../src/optimizer/target.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import type { NormalizedProfile } from '../../src/profile/types.js';
import { defaultExcluded, loadCatalogue } from '../../src/tasks/catalogue.js';
import { evaluateProgress, type TaskProgress } from '../../src/tasks/progress.js';
import type { Task } from '../../src/tasks/types.js';

// A tiny world: activity "grind" makes 10 items/min (any bracket) and feeds two side metrics.
const real = loadRates();
const rate = (activity: string, perMin: number): RateEntry => ({
  activity, unit: 'items/min', bracketBy: 'skill.farming', brackets: { early: [perMin, perMin], mid: [perMin, perMin], late: [perMin, perMin] },
});
const book: RateBook = { brackets: real.brackets, rates: new Map([['grind', rate('grind', 10)], ['side', rate('side', 1)]]) };
const ctx = { book };
const profile = { skills: { available: false, reason: 'off' } } as unknown as NormalizedProfile; // early bracket

function tp(id: string, metric: string, amount: number, current: number, extra: Partial<Task> = {}): TaskProgress {
  const task: Task = {
    id, category: 'x', name: id, description: id, xp: 1, requires: { metric, amount }, prerequisites: [],
    activity: metric === 'items' ? 'grind' : 'side', monetary: false, tracking: 'api', source: 't', ...extra,
  };
  return { task, status: 'verified_incomplete', current, required: amount, remaining: Math.max(0, amount - current), likelyComplete: false };
}
const combo = (per: [number, number] = [2, 4]): Combo => ({
  id: 'combo.grind', name: 'Grind', primary: 'grind', primaryMetrics: ['items'], source: 't',
  yields: [{ metric: 'xp', per, basis: 'b' }],
});
const ids = (ts: { id: string }[]) => ts.map((t) => t.id);

describe('scoreCombo', () => {
  it("runs to the primary's next tier and claims side tasks at the low end of the ratio", () => {
    const s = new PlanState([tp('items1', 'items', 100, 0, { xp: 4 }), tp('xp1', 'xp', 150, 0, { xp: 5 })]);
    const row = scoreCombo(combo(), s, profile, ctx)!;
    expect(row.horizon.task.id).toBe('items1');
    expect(row.units).toBe(100);
    expect(row.deltas).toEqual({ items: 100, xp: 200 }); // 100 items x 2 (low end), not 4
    expect(ids(row.tasks)).toEqual(['items1', 'xp1']);
    expect(row).toMatchObject({ xp: 9, minutes: [10, 10], midMinutes: 10 });
    expect(s.isComplete('items1')).toBe(false); // scoring never changes the state
  });

  it('runs on to the first side task when nothing else finishes at the primary tier, collecting tiers on the way', () => {
    const s = new PlanState([
      tp('items1', 'items', 100, 0), tp('items2', 'items', 200, 0, { prerequisites: ['items1'] }),
      tp('xp1', 'xp', 300, 0, { xp: 5 }),
    ]);
    const row = scoreCombo(combo(), s, profile, ctx)!;
    expect(row.horizon.task.id).toBe('xp1'); // 300 xp / 2 per item = 150 items
    expect(row.units).toBe(150);
    expect(ids(row.tasks).sort()).toEqual(['items1', 'xp1']);
  });

  it('is not a combo when only the primary would finish', () => {
    expect(scoreCombo(combo(), new PlanState([tp('items1', 'items', 100, 0)]), profile, ctx)).toBeUndefined();
  });

  it('respects exclusions and claims', () => {
    const list = [tp('items1', 'items', 100, 0), tp('xp1', 'xp', 150, 0, { group: 'xpsrc' })];
    expect(scoreCombo(combo(), new PlanState(list), profile, ctx, { excludedActivities: new Set(['grind']) })).toBeUndefined();
    expect(scoreCombo(combo(), new PlanState(list), profile, ctx, { excludedSources: new Set(['xpsrc']) })).toBeUndefined();
    expect(scoreCombo(combo(), new PlanState(list), profile, ctx, {}, new Set(['xp1']))).toBeUndefined();
    // Excluding the side task's own activity doesn't matter: the combo does it.
    expect(scoreCombo(combo(), new PlanState(list), profile, ctx, { excludedActivities: new Set(['side']) })).toBeDefined();
  });

  it('falls back to a yield when the primary has no open tier', () => {
    const s = new PlanState([{ ...tp('items1', 'items', 100, 100), status: 'verified_complete' }, tp('xp1', 'xp', 40, 0)]);
    const row = scoreCombo(combo(), s, profile, ctx)!;
    expect(row.horizon.task.id).toBe('xp1');
    expect(row.units).toBe(20);
  });
});

describe('rankWithCombos', () => {
  it('ranks a combo above its own primary task (same time, more XP) and drops the claimed single', () => {
    const list = [tp('items1', 'items', 100, 0, { xp: 4 }), tp('xp1', 'xp', 150, 0, { xp: 5 }), tp('other', 'side', 30, 0, { xp: 1 })];
    const r = rankWithCombos(list, profile, ctx, [combo()], { limit: 10 });
    expect(r.ranked.map((e) => (e.combo ? `combo:${e.combo.combo.id}` : e.progress.task.id))).toEqual(['combo:combo.grind', 'other']);
  });

  it('formats a combo row', () => {
    const list = [tp('items1', 'items', 100, 0, { xp: 4, name: 'Items I' }), tp('xp1', 'xp', 150, 0, { xp: 5, name: 'Skill 1' })];
    const row = scoreCombo(combo(), new PlanState(list), profile, ctx)!;
    expect(formatEntry(1, comboEntry(row))).toBe([
      '**1. ⚡ Grind** · +9 XP across 2 tasks',
      'Items I (+4) · Skill 1 (+5)',
      '~10 min (early bracket, assumed (no data)) · 0.90 XP/min',
      'side tasks counted at the low end',
    ].join('\n'));
  });
});

describe('planTarget with combos', () => {
  it('picks a combo when it beats single tasks on XP per minute, and replays it', () => {
    const list = [tp('items1', 'items', 100, 0, { xp: 4 }), tp('xp1', 'xp', 150, 0, { xp: 5 }), tp('slow', 'side', 100, 0, { xp: 5 })];
    const plan = planTarget(list, profile, ctx, 9, { combos: [combo()] });
    expect(plan.picks.map((p) => p.combo?.combo.id ?? p.progress.task.id)).toEqual(['combo.grind']);
    expect(plan).toMatchObject({ xp: 9, reached: true, minutes: [10, 10] });
    expect(targetLines(plan)[0]).toMatch(/^\*\*1\. ⚡ Grind\*\* · \+9 XP · ~10 min\n-# Σ 9 XP · ~10 min · completes items1, xp1$/);
  });

  it('counts a task once even when a combo and a single both reach it', () => {
    const list = [tp('items1', 'items', 100, 0, { xp: 4 }), tp('xp1', 'xp', 150, 0, { xp: 5 }), tp('items2', 'items', 200, 0, { xp: 4, prerequisites: ['items1'] })];
    const plan = planTarget(list, profile, ctx, 13, { combos: [combo()] });
    const done = plan.picks.flatMap((p) => p.completed.map((t) => t.id));
    expect(new Set(done).size).toBe(done.length);
    expect(plan.xp).toBe(13);
  });
});

describe('combos on a real profile', () => {
  const catalogue = loadCatalogue();
  const realBook = loadRates();
  const combos = loadCombos(catalogue, realBook);
  const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
  const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>('../fixtures/profiles-floor7sweat.json');
  const lime = normalizeProfile(pickProfile(response.profiles, 'lime')!, uuid, read<SkillsResource>('../fixtures/resource-skills.json'), 0);
  const progress = evaluateProgress(catalogue, lime).progress;
  const ex = { excluded: new Set(defaultExcluded(catalogue)) };

  it('lists combos that advance a task', () => {
    expect(combosFor(catalogue.byId.get('skills.combat.level43')!, combos).map((c) => c.id)).toContain('combo.slayer.zombie');
    expect(combosFor(catalogue.byId.get('collections.wheat.tier1')!, combos).map((c) => c.id)).toEqual(['combo.farm.wheat']);
  });

  it('never lists a task twice in /xp optimize, and keeps the single-task order otherwise', () => {
    const r = rankWithCombos(progress, lime, { book: realBook }, combos, { ...ex, limit: 3000 });
    const claimed = r.ranked.flatMap((e) => (e.combo ? e.combo.tasks.map((t) => t.id) : [e.progress.task.id]));
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(r.ranked.some((e) => e.combo)).toBe(true);
    const mids = r.ranked.map((e) => e.estimate.midMinutes);
    expect(mids).toEqual([...mids].sort((a, b) => a - b));
  });

  it('uses combos in /xp target and keeps the plan valid', () => {
    const plan = planTarget(progress, lime, { book: realBook }, 3000, { ...ex, combos });
    expect(plan.reached).toBe(true);
    expect(plan.picks.some((p) => p.combo)).toBe(true);
    const done = plan.picks.flatMap((p) => p.completed.map((t) => t.id));
    expect(new Set(done).size).toBe(done.length);
    expect(plan.picks.reduce((n, p) => n + p.xp, 0)).toBe(plan.xp);
  });
});

describe('measured combo ratios', () => {
  it("replace the data file's ratio (±15%, low end claimed) and are flagged on the row", () => {
    const s = new PlanState([tp('items1', 'items', 100, 0, { xp: 4 }), tp('xp1', 'xp', 150, 0, { xp: 5 })]);
    // Data says 2-4 per item; the player measured 1, so 100 items give 85 (not 200): xp1 isn't reached at the primary tier.
    const row = scoreCombo(combo(), s, profile, { book, comboRatios: { 'combo.grind': { xp: 1 } } })!;
    expect(row.measured).toEqual(['xp']);
    expect(row.horizon.task.id).toBe('xp1');
    expect(row.units).toBeCloseTo(150 / 0.85);
    expect(scoreCombo(combo(), s, profile, ctx)!.measured).toEqual([]);
    expect(formatEntry(1, comboEntry(row))).toContain('your measured ratios, low end');
  });
});

describe('comboView (/xp combos)', () => {
  it('lists every combo with something to do, best XP per minute first, without claiming between rows', () => {
    const list = [tp('items1', 'items', 100, 0, { xp: 4 }), tp('xp1', 'xp', 150, 0, { xp: 5 })];
    const second: Combo = { ...combo([3, 3]), id: 'combo.grind2', name: 'Grind 2' };
    const idle: Combo = { ...combo(), id: 'combo.idle', name: 'Idle', primary: 'side', primaryMetrics: ['side'], yields: [{ metric: 'nothing', per: [1, 1], basis: 'b' }] };
    const v = comboView(list, profile, ctx, [combo(), second, idle]);
    // Both rows finish xp1: nothing is claimed between rows here.
    expect(v.rows.map((r) => r.combo!.combo.id).sort()).toEqual(['combo.grind', 'combo.grind2']);
    expect(v.rows.every((r) => r.combo!.tasks.some((t) => t.id === 'xp1'))).toBe(true);
    expect(v.idle.map((c) => c.id)).toEqual(['combo.idle']);
    const mine = comboView(list, profile, ctx, [combo()], { excludedActivities: new Set(['grind']) });
    expect(mine).toMatchObject({ rows: [], idle: [] });
    expect(mine.excluded.map((c) => c.id)).toEqual(['combo.grind']);
  });

  it('sorts real combos by XP per minute', () => {
    const catalogue = loadCatalogue();
    const realBook = loadRates();
    const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
    const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>('../fixtures/profiles-floor7sweat.json');
    const lime = normalizeProfile(pickProfile(response.profiles, 'lime')!, uuid, read<SkillsResource>('../fixtures/resource-skills.json'), 0);
    const all = loadCombos(catalogue, realBook);
    const v = comboView(evaluateProgress(catalogue, lime).progress, lime, { book: realBook }, all, { excluded: new Set(defaultExcluded(catalogue)) });
    expect(v.rows.length + v.idle.length).toBe(all.length);
    const r = v.rows.map((x) => x.estimate.xpPerMin);
    expect(r).toEqual([...r].sort((a, b) => b - a));
  });
});
