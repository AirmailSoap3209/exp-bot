import { activityRate, minutesFor, spread, type ActivityRate, type EstimateContext } from '../estimate/estimate.js';
import type { Bracket, Range } from '../estimate/types.js';
import { isExcluded, type Exclusions } from '../optimizer/eligible.js';
import type { PlanState } from '../optimizer/plan.js';
import type { NormalizedProfile } from '../profile/types.js';
import type { TaskProgress } from '../tasks/progress.js';
import type { Task } from '../tasks/types.js';
import { yieldPer, type Combo, type ComboYield } from './combos.js';

/** One combo, scored against a plan state: how long it runs and what it completes. */
export interface ComboRow {
  combo: Combo;
  /** The task that sets how long the row runs: the primary's next tier, or a yield's when the primary has none. */
  horizon: TaskProgress;
  /** Primary units done over the horizon (items, kills, slayer XP, runs). */
  units: number;
  minutes: Range;
  midMinutes: number;
  rate: ActivityRate;
  /** What the row adds to each metric; other yields at the low end of their ratio. */
  deltas: Record<string, number>;
  /** Rewarded tasks it completes, the horizon first. */
  tasks: Task[];
  xp: number;
  /** Yield metrics that used the player's measured ratio instead of the data file's. */
  measured: string[];
}

/** A yield's range: the player's measured ratio (±15%, like measured rates) when there is one, else the data file's. */
function perFor(combo: Combo, y: ComboYield, bracket: Bracket, ctx: EstimateContext): Range {
  const m = ctx.comboRatios?.[combo.id]?.[y.metric];
  return m && m > 0 ? spread(m) : yieldPer(y, bracket);
}

/**
 * Scores a combo on `state` without changing it.
 *  - Runs until the primary's next open tier (the quickest one if the primary feeds several metrics);
 *    when the primary has none open or allowed, until the next open tier of its first reachable yield.
 *  - Primary progress is exact over that run; every other yield counts only at the low end of its ratio,
 *    so the XP is a floor.
 *  - Excluded (category or source), monetary and `claimed` tasks earn nothing.
 * Returns undefined when the primary's activity is excluded, has no rate, has nothing to run until,
 * or the row completes nothing beyond the primary's own tasks (then it's just a single task).
 */
export function scoreCombo(
  combo: Combo,
  state: PlanState,
  profile: NormalizedProfile,
  ctx: EstimateContext,
  ex: Exclusions = {},
  claimed: ReadonlySet<string> = new Set(),
): ComboRow | undefined {
  if (ex.excludedActivities?.has(combo.primary)) return undefined;
  const rate = activityRate(combo.primary, profile, ctx);
  if (!rate) return undefined;
  // The horizon may be a task whose own activity is excluded: doing the combo isn't doing that activity.
  const offered: Exclusions = { excluded: ex.excluded, excludedSources: ex.excludedSources };

  // Where the row could stop: the primary's next open tier, or a yield's (in primary units).
  const stops: { p: TaskProgress; units: number }[] = [];
  for (const m of combo.primaryMetrics) {
    const p = state.nextOpen(m, offered);
    const u = p ? state.remainingFor(p.task) : 0;
    if (p && u > 0) stops.push({ p, units: u });
  }
  for (const y of combo.yields) {
    const p = state.nextOpen(y.metric, offered);
    const u = p ? state.remainingFor(p.task) / perFor(combo, y, rate.gearBracket, ctx)[0] : 0;
    if (p && u > 0 && Number.isFinite(u)) stops.push({ p, units: u });
  }
  stops.sort((a, b) => a.units - b.units);

  const earns = (t: Task) => !t.monetary && !isExcluded(t, ex) && !claimed.has(t.id);
  const own = new Set(combo.primaryMetrics);
  const deltasFor = (units: number) => {
    const d: Record<string, number> = {};
    for (const m of combo.primaryMetrics) d[m] = units;
    for (const y of combo.yields) d[y.metric] = (d[y.metric] ?? 0) + units * perFor(combo, y, rate.gearBracket, ctx)[0];
    return d;
  };
  // Run until the primary's next tier; if nothing else finishes by then, run on to the first
  // stop where something else does (a grind until the next skill level), collecting every
  // primary tier on the way. Otherwise the row is just its primary task.
  let horizon: TaskProgress | undefined, units = 0, deltas: Record<string, number> = {}, done: Task[] = [];
  const primaryStop = stops.find((s) => own.has(s.p.task.requires.metric));
  for (const s of stops) {
    if (primaryStop && s.units < primaryStop.units) continue;
    const d = deltasFor(s.units);
    const got = state.tryApply(d).newlyCompleted.filter(earns);
    if (got.some((t) => !own.has(t.requires.metric))) {
      [horizon, units, deltas, done] = [s.p, s.units, d, got];
      break;
    }
  }
  if (!horizon) return undefined;

  const h = horizon.task.id;
  const tasks = [...done.filter((t) => t.id === h), ...done.filter((t) => t.id !== h)];
  const minutes = minutesFor(combo.primary, units, rate, ctx);
  return {
    combo, horizon, units, minutes, midMinutes: (minutes[0] + minutes[1]) / 2, rate, deltas,
    tasks, xp: tasks.reduce((n, t) => n + t.xp, 0),
    measured: combo.yields.filter((y) => (ctx.comboRatios?.[combo.id]?.[y.metric] ?? 0) > 0).map((y) => y.metric),
  };
}

/** Combos that advance a task's metric, as a yield or as their primary. */
export function combosFor(task: Task, combos: readonly Combo[]): Combo[] {
  return combos.filter((c) => c.primaryMetrics.includes(task.requires.metric) || c.yields.some((y) => y.metric === task.requires.metric));
}
