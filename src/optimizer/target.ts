import { estimateTask, type Estimate, type EstimateContext, type RateSource } from '../estimate/estimate.js';
import type { Range } from '../estimate/types.js';
import type { NormalizedProfile } from '../profile/types.js';
import type { TaskProgress } from '../tasks/progress.js';
import type { Task } from '../tasks/types.js';
import { isExcluded, type Exclusions } from './eligible.js';
import { PlanState } from './plan.js';

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
}

const MAX_PICKS = 5000;
const mid = (r: Range) => (r[0] + r[1]) / 2;

/** XP a completed task is worth to the plan: none for monetary or excluded tasks. */
const rewardOf = (t: Task, ex: Exclusions) => (t.monetary || isExcluded(t, ex) ? 0 : t.xp);

/**
 * Replays an ordered list of task IDs from the profile's real progress.
 * Returns undefined if any step can't be done at its turn (a prerequisite was removed).
 */
function simulate(order: readonly string[], progress: readonly TaskProgress[], profile: NormalizedProfile, ctx: EstimateContext, ex: Exclusions) {
  const state = new PlanState(progress);
  const picks: TargetPick[] = [];
  let xp = 0;
  const minutes: Range = [0, 0];
  for (const id of order) {
    if (!state.isAvailable(id)) return undefined;
    const p = state.progressFor(id)!;
    const estimate = estimateTask(p, profile, ctx);
    if (!estimate) return undefined;
    const completed = state.applyTask(id).newlyCompleted.filter((t) => rewardOf(t, ex) > 0);
    const gained = completed.reduce((n, t) => n + rewardOf(t, ex), 0);
    xp += gained;
    minutes[0] += estimate.minutes[0];
    minutes[1] += estimate.minutes[1];
    picks.push({ progress: p, estimate, xp: gained, completed, total: { xp, minutes: [minutes[0], minutes[1]] } });
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

  const order: string[] = [];
  let gained = 0;
  while (gained < target && order.length < maxPicks) {
    const need = target - gained;
    let best: { p: TaskProgress; m: number; ratio: number } | undefined;
    let cover: { p: TaskProgress; m: number } | undefined;
    for (const p of state.candidates(opts)) {
      const e = estimate(p);
      if (!e) continue;
      const m = Math.max(e.midMinutes, 1e-6);
      const ratio = p.task.xp / m;
      if (!best || ratio > best.ratio || (ratio === best.ratio && (p.task.xp > best.p.task.xp || (p.task.xp === best.p.task.xp && p.task.id < best.p.task.id)))) {
        best = { p, m, ratio };
      }
      if (p.task.xp >= need && (!cover || m < cover.m || (m === cover.m && p.task.id < cover.p.task.id))) cover = { p, m };
    }
    if (!best) break;
    const pick = cover && cover.m < best.m ? cover.p : best.p;
    order.push(pick.task.id);
    gained += state.applyTask(pick.task.id).newlyCompleted.reduce((n, t) => n + rewardOf(t, opts), 0);
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
