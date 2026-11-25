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
 *  - Runs at least until the primary's next open tier, then on to whichever upcoming tier (of the
 *    primary or any yield) gives the row its best XP per minute.
 *  - Primary progress is exact over that run; every other yield counts only at the low end of its ratio,
 *    so the XP is a floor.
 *  - Excluded (category or source), monetary and `claimed` tasks earn nothing.
 * Returns undefined when the primary's activity is excluded or can't be reached (access gate), has no rate, has nothing to run until,
 * or no stop finishes tasks on two metrics, one of them a yield (then it's just a single task).
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
  // Can't do the primary (no access to where it's done): the side yields don't make it doable.
  if (combo.primaryMetrics.every((m) => state.blockedOn(m))) return undefined;
  const rate = activityRate(combo.primary, profile, ctx);
  if (!rate) return undefined;
  // The horizon may be a task whose own activity is excluded: doing the combo isn't doing that activity.
  const offered: Exclusions = { excluded: ex.excluded, excludedSources: ex.excludedSources };

  // Every point where the row could stop: each upcoming tier of the primary and of every yield,
  // in primary units (yields at the low end of their ratio).
  const per = new Map(combo.yields.map((y) => [y.metric, perFor(combo, y, rate.gearBracket, ctx)[0]]));
  const stops: { p: TaskProgress; units: number }[] = [];
  for (const m of combo.primaryMetrics) {
    for (const p of state.upcoming(m, offered, STOPS_PER_METRIC)) stops.push({ p, units: state.remainingFor(p.task) });
  }
  for (const y of combo.yields) {
    for (const p of state.upcoming(y.metric, offered, STOPS_PER_METRIC)) stops.push({ p, units: state.remainingFor(p.task) / per.get(y.metric)! });
  }
  const own = new Set(combo.primaryMetrics);
  const ordered = stops.filter((s) => s.units > 0 && Number.isFinite(s.units)).sort((a, b) => a.units - b.units);
  // The row runs at least until the primary's next tier, when it has one.
  const first = ordered.find((s) => own.has(s.p.task.requires.metric))?.units ?? 0;
  const candidates = ordered.filter((s) => s.units >= first).slice(0, MAX_STOPS);

  const earns = (t: Task) => !t.monetary && !isExcluded(t, ex) && !claimed.has(t.id);
  const deltasFor = (units: number) => {
    const d: Record<string, number> = {};
    for (const m of combo.primaryMetrics) d[m] = units;
    for (const [m, r] of per) d[m] = (d[m] ?? 0) + units * r;
    return d;
  };
  // Stop where the row's XP per minute is best: that's what the list is sorted by, and it keeps a
  // row from ending on a 1 XP side tier when a skill level is just past it (or running on for days
  // for one more). It must finish tasks on at least two metrics, else it's a single task in disguise
  // (a maxed collection plus one crop milestone is just that milestone).
  let best: { s: (typeof candidates)[number]; d: Record<string, number>; done: Task[]; minutes: Range; xp: number } | undefined;
  for (const s of candidates) {
    const d = deltasFor(s.units);
    const done = state.tryApply(d).newlyCompleted.filter(earns);
    if (!done.some((t) => !own.has(t.requires.metric)) || new Set(done.map((t) => t.requires.metric)).size < 2) continue;
    const minutes = minutesFor(combo.primary, s.units, rate, ctx);
    const xp = done.reduce((n, t) => n + t.xp, 0);
    const rateOf = (b: { xp: number; minutes: Range }) => b.xp / (b.minutes[0] + b.minutes[1]);
    if (!best || rateOf({ xp, minutes }) > rateOf(best) || (rateOf({ xp, minutes }) === rateOf(best) && xp > best.xp)) {
      best = { s, d, done, minutes, xp };
    }
  }
  if (!best) return undefined;

  // The horizon is the stop the row runs until; list it first, then the rest by XP.
  const horizon = state.progressFor(best.s.p.task.id)!;
  const h = horizon.task.id;
  const tasks = [...best.done.filter((t) => t.id === h), ...best.done.filter((t) => t.id !== h).sort((a, b) => b.xp - a.xp)];
  return {
    combo, horizon, units: best.s.units, minutes: best.minutes, midMinutes: (best.minutes[0] + best.minutes[1]) / 2, rate, deltas: best.d,
    tasks, xp: best.xp,
    measured: combo.yields.filter((y) => y.learned || (ctx.comboRatios?.[combo.id]?.[y.metric] ?? 0) > 0).map((y) => y.metric),
  };
}

/** How many upcoming tiers of each metric to consider, and how many stops in all. */
const STOPS_PER_METRIC = 12;
const MAX_STOPS = 40;

/** Combos that advance a task's metric, as a yield or as their primary. */
export function combosFor(task: Task, combos: readonly Combo[]): Combo[] {
  return combos.filter((c) => c.primaryMetrics.includes(task.requires.metric) || c.yields.some((y) => y.metric === task.requires.metric));
}
