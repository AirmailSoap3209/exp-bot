import type { TaskProgress } from '../tasks/progress.js';
import type { Task } from '../tasks/types.js';

/** What the user left out: whole categories, or single sources (task groups). */
export interface Exclusions {
  /** Category IDs. */
  excluded?: ReadonlySet<string>;
  /** Source IDs (task groups). */
  excludedSources?: ReadonlySet<string>;
  /**
   * Activity IDs the user doesn't want to do. A task or combo using one is never recommended,
   * but its XP still counts when something else completes it (unlike category and source exclusions).
   */
  excludedActivities?: ReadonlySet<string>;
}

export type DropReason = 'monetary' | 'excluded' | 'done' | 'unavailable' | 'blocked';

/** Source of a task, as used by source exclusions. */
export const sourceOf = (t: Task) => t.group ?? t.id;

/** Counts as finished for prerequisite purposes, including estimates that say done. */
export const isDone = (p: TaskProgress) => p.status === 'verified_complete' || p.status === 'ticked' || (p.status === 'estimated' && p.likelyComplete);

export const isExcluded = (t: Task, ex: Exclusions) => !!(ex.excluded?.has(t.category) || ex.excludedSources?.has(sourceOf(t)));

/**
 * Why a task can't be recommended right now, or undefined when it can.
 * Checked in this order: monetary, excluded, done, unavailable, blocked.
 * `done(id)` says whether a prerequisite is finished; an unknown ID counts as unfinished.
 */
export function dropReason(p: TaskProgress, done: (id: string) => boolean, ex: Exclusions, selfDone = isDone(p)): DropReason | undefined {
  const t = p.task;
  if (t.monetary) return 'monetary';
  if (isExcluded(t, ex) || (t.activity && ex.excludedActivities?.has(t.activity))) return 'excluded';
  if (selfDone) return 'done';
  if (p.status === 'unavailable') return 'unavailable';
  if (p.blocked || t.prerequisites.some((id) => !done(id))) return 'blocked';
  return undefined;
}
