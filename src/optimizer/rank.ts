import { estimateTask, type Estimate, type EstimateContext } from '../estimate/estimate.js';
import type { ComboRow } from '../combos/score.js';
import type { NormalizedProfile } from '../profile/types.js';
import type { TaskProgress } from '../tasks/progress.js';
import { dropReason, isDone, type Exclusions } from './eligible.js';

export interface RankedTask {
  progress: TaskProgress;
  estimate: Estimate;
  /** Set when this entry is a combo row; progress and estimate are then its horizon task's. */
  combo?: ComboRow;
}

export interface RankResult {
  ranked: RankedTask[];
  /** Why tasks left the pool, for the footer and for debugging. */
  dropped: Record<'done' | 'monetary' | 'excluded' | 'unavailable' | 'blocked' | 'laterTier' | 'noRate', number>;
}

/** Excluded categories and sources are both counted under dropped.excluded. */
export interface RankOptions extends Exclusions {
  limit?: number;
}

/**
 * Ranks the quickest eligible tasks:
 *  1. statuses come in already evaluated
 *  2. drop monetary, done, unavailable, excluded and blocked tasks
 *  3. keep only the next unfinished tier of each tiered source
 *  4. estimate minutes (remaining / rate, as a range)
 *  5. sort by the middle of the range; ties go to more XP
 */
export function rankTasks(progress: TaskProgress[], profile: NormalizedProfile, ctx: EstimateContext, opts: RankOptions = {}): RankResult {
  const dropped: RankResult['dropped'] = { done: 0, monetary: 0, excluded: 0, unavailable: 0, blocked: 0, laterTier: 0, noRate: 0 };
  const byId = new Map(progress.map((p) => [p.task.id, p]));

  const pool: TaskProgress[] = [];
  const done = (id: string) => { const pre = byId.get(id); return !!pre && isDone(pre); };
  for (const p of progress) {
    const reason = dropReason(p, done, opts);
    if (reason) dropped[reason]++;
    else pool.push(p);
  }

  // Prerequisite chains already leave one tier per source; this guards sources without a chain.
  const nextTier = new Map<string, TaskProgress>();
  const ungrouped: TaskProgress[] = [];
  for (const p of pool) {
    const g = p.task.group;
    if (!g) {
      ungrouped.push(p);
      continue;
    }
    const cur = nextTier.get(g);
    if (!cur || (p.task.tier ?? 0) < (cur.task.tier ?? 0)) {
      if (cur) dropped.laterTier++;
      nextTier.set(g, p);
    } else dropped.laterTier++;
  }

  const ranked: RankedTask[] = [];
  for (const p of [...nextTier.values(), ...ungrouped]) {
    const estimate = estimateTask(p, profile, ctx);
    if (estimate) ranked.push({ progress: p, estimate });
    else dropped.noRate++;
  }
  ranked.sort((a, b) =>
    a.estimate.midMinutes - b.estimate.midMinutes || b.progress.task.xp - a.progress.task.xp || a.progress.task.id.localeCompare(b.progress.task.id));
  return { ranked: ranked.slice(0, opts.limit ?? 10), dropped };
}
