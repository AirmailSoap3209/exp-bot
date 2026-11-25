import type { Combo } from '../combos/combos.js';
import { scoreCombo, type ComboRow } from '../combos/score.js';
import type { Estimate, EstimateContext } from '../estimate/estimate.js';
import type { NormalizedProfile } from '../profile/types.js';
import type { TaskProgress } from '../tasks/progress.js';
import { PlanState } from './plan.js';
import { rankTasks, type RankedTask, type RankOptions, type RankResult } from './rank.js';

/** A combo row as a ranked entry: its horizon task's progress, with the row's time and XP. */
export function comboEntry(row: ComboRow): RankedTask {
  const r = row.rate;
  const estimate: Estimate = {
    minutes: row.minutes, midMinutes: row.midMinutes, xpPerMin: row.xp / row.midMinutes,
    source: r.source, unit: r.unit, rate: r.rate, assumedNoProgress: row.horizon.remaining === null,
    ...(r.bracket ? { bracket: r.bracket } : {}), ...(r.bracketInfo ? { bracketInfo: r.bracketInfo } : {}),
  };
  return { progress: row.horizon, estimate, combo: row };
}

export interface ComboView {
  /** Combos with something to do, best XP per minute first. */
  rows: RankedTask[];
  /** Combos that have nothing to do right now (locked, maxed, or finish nothing beyond their primary). */
  idle: Combo[];
  /** Combos left out because the user excluded their primary activity. */
  excluded: Combo[];
}

/**
 * /xp combos: every combo scored on the real profile. Each row stands alone (nothing is claimed
 * between rows, unlike /xp optimize), so it shows everything that combo would finish.
 */
export function comboView(
  progress: TaskProgress[],
  profile: NormalizedProfile,
  ctx: EstimateContext,
  combos: readonly Combo[],
  ex: RankOptions = {},
): ComboView {
  const state = new PlanState(progress);
  const rows: RankedTask[] = [];
  const idle: Combo[] = [];
  const excluded: Combo[] = [];
  for (const c of combos) {
    if (ex.excludedActivities?.has(c.primary)) { excluded.push(c); continue; }
    const row = scoreCombo(c, state, profile, ctx, ex);
    if (row) rows.push(comboEntry(row));
    else idle.push(c);
  }
  rows.sort((a, b) => b.estimate.xpPerMin - a.estimate.xpPerMin || a.estimate.midMinutes - b.estimate.midMinutes || a.combo!.combo.id.localeCompare(b.combo!.combo.id));
  return { rows, idle, excluded };
}

/** Quicker first; on a tie, more XP. */
const before = (a: { mid: number; xp: number }, b: { mid: number; xp: number }) => a.mid < b.mid || (a.mid === b.mid && a.xp > b.xp);

/**
 * /xp optimize with combos alongside single tasks. Each entry is a separate choice, so rows
 * start from the real profile (no progress carries between them), but a task appears once:
 * the quickest entry claims its tasks, and later rows are re-scored without them. A single
 * task a row has claimed drops out. Each combo appears at most once.
 */
export function rankWithCombos(
  progress: TaskProgress[],
  profile: NormalizedProfile,
  ctx: EstimateContext,
  combos: readonly Combo[],
  opts: RankOptions = {},
): RankResult {
  const limit = opts.limit ?? 10;
  const base = rankTasks(progress, profile, ctx, { ...opts, limit: Number.MAX_SAFE_INTEGER });
  const state = new PlanState(progress);
  const claimed = new Set<string>();
  const left = [...combos];
  const ranked: RankedTask[] = [];
  let i = 0;
  while (ranked.length < limit) {
    while (i < base.ranked.length && claimed.has(base.ranked[i]!.progress.task.id)) i++;
    const single = base.ranked[i];
    let best: { row: ComboRow; at: number } | undefined;
    left.forEach((c, at) => {
      const row = scoreCombo(c, state, profile, ctx, opts, claimed);
      if (row && (!best || before({ mid: row.midMinutes, xp: row.xp }, { mid: best.row.midMinutes, xp: best.row.xp }))) best = { row, at };
    });
    if (best && (!single || !before({ mid: single.estimate.midMinutes, xp: single.progress.task.xp }, { mid: best.row.midMinutes, xp: best.row.xp }))) {
      ranked.push(comboEntry(best.row));
      for (const t of best.row.tasks) claimed.add(t.id);
      left.splice(best.at, 1);
    } else if (single) {
      ranked.push(single);
      claimed.add(single.progress.task.id);
      i++;
    } else break;
  }
  return { ranked, dropped: base.dropped };
}
