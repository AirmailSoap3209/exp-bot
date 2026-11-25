import { estimateTask, type Estimate, type EstimateContext, type RateSource } from '../estimate/estimate.js';
import type { Range } from '../estimate/types.js';
import type { NormalizedProfile } from '../profile/types.js';
import type { TaskProgress } from '../tasks/progress.js';
import type { Task } from '../tasks/types.js';
import { isExcluded, type Exclusions } from './eligible.js';
import { PlanState } from './plan.js';
import type { Combo } from '../combos/combos.js';
import { scoreCombo, type ComboRow } from '../combos/score.js';
import { comboEntry } from './combined.js';

export interface TargetPick {
  /** Progress as it stood when this step started, after the steps before it. */
  progress: TaskProgress;
  estimate: Estimate;
  /** XP this step earns: the task, plus anything it completes on the way (unlocked dependents already met). */
  xp: number;
  /** Rewarded tasks this step completes, the picked task first. */
  completed: Task[];
  /** Running totals up to and including this step. */
  total: { xp: number; minutes: Range };
  /** Set when this step is a combo; progress is then its horizon task's. */
  combo?: ComboRow;
}

export interface TargetPlan {
  target: number;
  picks: TargetPick[];
  /** XP the plan earns. Fixed rewards only, so this is a floor, not an estimate. */
  xp: number;
  minutes: Range;
  midMinutes: number;
  reached: boolean;
  /** Stopped at maxPicks before reaching the target. */
  capped: boolean;
  /** Steps the trim pass removed. */
  trimmed: number;
  rateSources: Record<RateSource, number>;
  /** Steps whose progress was estimated (bestiary), which may already be done in game. */
  estimatedSteps: number;
}

export interface TargetOptions extends Exclusions {
  maxPicks?: number;
  /** Combos that compete with single tasks (data/combos). */
  combos?: readonly Combo[];
}

/** Steps are task IDs, or combo IDs (which always start with "combo."). */
const isComboStep = (id: string) => id.startsWith('combo.');

const MAX_PICKS = 5000;
const mid = (r: Range) => (r[0] + r[1]) / 2;

/** XP a completed task is worth to the plan: none for monetary or excluded tasks. */
const rewardOf = (t: Task, ex: Exclusions) => (t.monetary || isExcluded(t, ex) ? 0 : t.xp);

/**
 * Replays an ordered list of steps from the profile's real progress. A combo step is re-scored
 * on the state at its turn. Returns undefined if any step can't be done then (a prerequisite was
 * removed, or a combo has nothing left to do).
 */
function simulate(order: readonly string[], progress: readonly TaskProgress[], profile: NormalizedProfile, ctx: EstimateContext, ex: TargetOptions) {
  const state = new PlanState(progress);
  const combos = new Map((ex.combos ?? []).map((c) => [c.id, c]));
  const picks: TargetPick[] = [];
  let xp = 0;
  const minutes: Range = [0, 0];
  for (const id of order) {
    let p: TaskProgress, estimate: Estimate | undefined, done: Task[], combo: ComboRow | undefined;
    if (isComboStep(id)) {
      const c = combos.get(id);
      combo = c && scoreCombo(c, state, profile, ctx, ex);
      if (!combo) return undefined;
      ({ progress: p, estimate } = comboEntry(combo));
      done = state.apply(combo.deltas).newlyCompleted;
    } else {
      if (!state.isAvailable(id)) return undefined;
      p = state.progressFor(id)!;
      estimate = estimateTask(p, profile, ctx);
      if (!estimate) return undefined;
      done = state.applyTask(id).newlyCompleted;
    }
    const completed = done.filter((t) => rewardOf(t, ex) > 0);
    const gained = completed.reduce((n, t) => n + rewardOf(t, ex), 0);
    xp += gained;
    minutes[0] += estimate.minutes[0];
    minutes[1] += estimate.minutes[1];
    picks.push({ progress: p, estimate, xp: gained, completed, total: { xp, minutes: [minutes[0], minutes[1]] }, ...(combo ? { combo } : {}) });
  }
  return { picks, xp, minutes };
}

/**
 * The quickest set of tasks to earn `target` XP:
 *  1. greedy: take the candidate with the most XP per minute (midpoint estimate),
 *     apply it to the simulated profile, and repeat; next tiers and unlocked tasks
 *     become candidates as they open up
 *  2. finish step: when one candidate covers everything still needed faster than
 *     the best-ratio pick alone, take it instead
 *  3. trim: drop steps the target doesn't need, slowest first, but only when the
 *     replayed plan is still valid, still reaches the target, and is quicker
 */
export function planTarget(
  progress: readonly TaskProgress[],
  profile: NormalizedProfile,
  ctx: EstimateContext,
  target: number,
  opts: TargetOptions = {},
): TargetPlan {
  const maxPicks = opts.maxPicks ?? MAX_PICKS;
  const state = new PlanState(progress);
  // Estimates depend only on the task and what's left of it.
  const cache = new Map<string, Estimate | undefined>();
  const estimate = (p: TaskProgress) => {
    const key = `${p.task.id}:${p.remaining}`;
    if (!cache.has(key)) cache.set(key, estimateTask(p, profile, ctx));
    return cache.get(key);
  };

  /** One option this turn: a single task, or a combo with its scored row. */
  interface Option { id: string; xp: number; m: number; ratio: number; row?: ComboRow }
  const better = (a: Option, b: Option) => a.ratio > b.ratio || (a.ratio === b.ratio && (a.xp > b.xp || (a.xp === b.xp && a.id < b.id)));
  const quicker = (a: Option, b: Option) => a.m < b.m || (a.m === b.m && a.id < b.id);

  const order: string[] = [];
  let gained = 0;
  while (gained < target && order.length < maxPicks) {
    const need = target - gained;
    const options: Option[] = [];
    for (const p of state.candidates(opts)) {
      const e = estimate(p);
      if (!e) continue;
      const m = Math.max(e.midMinutes, 1e-6);
      options.push({ id: p.task.id, xp: p.task.xp, m, ratio: p.task.xp / m });
    }
    for (const c of opts.combos ?? []) {
      const row = scoreCombo(c, state, profile, ctx, opts);
      if (!row) continue;
      const m = Math.max(row.midMinutes, 1e-6);
      options.push({ id: c.id, xp: row.xp, m, ratio: row.xp / m, row });
    }
    let best: Option | undefined;
    let cover: Option | undefined;
    for (const o of options) {
      if (!best || better(o, best)) best = o;
      if (o.xp >= need && (!cover || quicker(o, cover))) cover = o;
    }
    if (!best) break;
    const pick = cover && cover.m < best.m ? cover : best;
    order.push(pick.id);
    const done = pick.row ? state.apply(pick.row.deltas).newlyCompleted : state.applyTask(pick.id).newlyCompleted;
    gained += done.reduce((n, t) => n + rewardOf(t, opts), 0);
  }

  let plan = simulate(order, progress, profile, ctx, opts)!;
  const capped = plan.xp < target && order.length >= maxPicks;
  let trimmed = 0;

  if (plan.xp >= target) {
    // Each removal is checked by replaying the whole plan, so a step that a later
    // step depends on (by prerequisite or by shared progress) is never dropped.
    let changed = true;
    while (changed) {
      changed = false;
      const spare = plan.xp - target;
      const tries = plan.picks
        .map((s, i) => ({ i, xp: s.xp, m: s.estimate.midMinutes }))
        .filter((s) => s.xp <= spare)
        .sort((a, b) => b.m - a.m);
      for (const t of tries) {
        const next = order.filter((_, i) => i !== t.i);
        const replay = simulate(next, progress, profile, ctx, opts);
        if (replay && replay.xp >= target && mid(replay.minutes) < mid(plan.minutes)) {
          order.splice(t.i, 1);
          plan = replay;
          trimmed++;
          changed = true;
          break;
        }
      }
    }
  }

  const rateSources: Record<RateSource, number> = { fixed: 0, session: 0, override: 0, default: 0 };
  for (const s of plan.picks) rateSources[s.estimate.source]++;
  return {
    target,
    picks: plan.picks,
    xp: plan.xp,
    minutes: plan.minutes,
    midMinutes: mid(plan.minutes),
    reached: plan.xp >= target,
    capped,
    trimmed,
    rateSources,
    estimatedSteps: plan.picks.filter((s) => s.progress.status === 'estimated').length,
  };
}

/** XP needed to reach a SkyBlock level (100 XP per level), from total XP; 0 or less means already there. */
export const xpToLevel = (level: number, experience: number) => level * 100 - experience;
