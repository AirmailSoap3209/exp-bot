import type { NormalizedProfile } from '../profile/types.js';
import type { Catalogue } from './catalogue.js';
import { applyAccess } from './access.js';
import { readerFor } from './readers/index.js';
import type { Task } from './types.js';

/**
 * How far a reader's number can be trusted:
 * - exact:      straight from the API
 * - lowerBound: true value is at least this (e.g. a co-op member's share is hidden)
 * - approx:     worked out from related data that may be off either way
 */
export type Confidence = 'exact' | 'lowerBound' | 'approx';

/** What a category reader reports for one task. */
export type Reading =
  | {
      kind: 'measured';
      current: number;
      confidence: Confidence;
      /** Overrides `current >= amount`, for tasks where a number alone doesn't decide it (skill caps). */
      complete?: boolean;
      /** The task can't be progressed yet for a reason other than prerequisites. */
      blocked?: string;
    }
  | { kind: 'unavailable'; reason: string };

export type Reader = (task: Task, profile: NormalizedProfile) => Reading;

export const STATUSES = ['verified_complete', 'verified_incomplete', 'estimated', 'ticked', 'unavailable'] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  verified_complete: 'Verified complete',
  verified_incomplete: 'Verified incomplete',
  estimated: 'Estimated',
  ticked: 'Manually ticked',
  unavailable: 'Unavailable',
};

export interface TaskProgress {
  task: Task;
  status: Status;
  /** Progress toward requires.amount; null when unknown. */
  current: number | null;
  required: number;
  remaining: number | null;
  /** Estimated tasks whose estimate says they're done. Not ranked, not counted as earned. */
  likelyComplete: boolean;
  blocked?: string;
  /** Why the status is what it is, for unavailable and estimated tasks. */
  reason?: string;
}

export interface Evaluation {
  progress: TaskProgress[];
  /** Ticks the API has contradicted; the caller should remove them from storage. */
  ticksToClear: string[];
}

function measured(task: Task, r: Extract<Reading, { kind: 'measured' }>): Omit<TaskProgress, 'status' | 'likelyComplete'> & { complete: boolean } {
  const required = task.requires.amount;
  const complete = r.complete ?? r.current >= required;
  return {
    task,
    current: r.current,
    required,
    remaining: complete ? 0 : Math.max(0, required - r.current),
    blocked: complete ? undefined : r.blocked,
    complete,
  };
}

/** Gives one task exactly one status. Pure: no storage, no API. */
export function evaluateTask(task: Task, profile: NormalizedProfile, ticked: boolean): { progress: TaskProgress; clearTick: boolean } {
  const required = task.requires.amount;
  const base = { task, required, likelyComplete: false };
  const tasksList = profile.leveling.completedTasks;

  // 1. Hypixel's own completed-task list is the strongest evidence of completion.
  if (task.hypixelTaskId && tasksList.available && tasksList.value.has(task.hypixelTaskId)) {
    return { progress: { ...base, status: 'verified_complete', current: required, remaining: 0 }, clearTick: false };
  }

  if (task.tracking !== 'api') {
    const status = ticked ? 'ticked' : 'unavailable';
    return { progress: { ...base, status, current: null, remaining: null, reason: `Tracked ${task.tracking}; tick it when done` }, clearTick: false };
  }

  // task.<ID> metrics have no reader: Hypixel's completed-task list is the only evidence.
  const reader = task.requires.metric.startsWith('task.') ? undefined : readerFor(task.category);
  const reading: Reading = reader
    ? reader(task, profile)
    : { kind: 'unavailable', reason: task.hypixelTaskId ? "Tracked through Hypixel's completed-task list" : 'No progress reader for this category yet' };

  if (reading.kind === 'unavailable') {
    // The task list can still prove a task incomplete even when the reader has no numbers,
    // unless the ID itself is a pattern guess: then it's only an estimate, and can be ticked.
    if (task.hypixelTaskId && tasksList.available && !ticked) {
      if (task.hypixelTaskIdUnconfirmed) {
        const reason = `Task ID ${task.hypixelTaskId} is unconfirmed, so this may already be done; tick it if it is`;
        return { progress: { ...base, status: 'estimated', current: 0, remaining: required, reason }, clearTick: false };
      }
      return { progress: { ...base, status: 'verified_incomplete', current: null, remaining: null, reason: reading.reason }, clearTick: false };
    }
    return { progress: { ...base, status: ticked ? 'ticked' : 'unavailable', current: null, remaining: null, reason: reading.reason }, clearTick: false };
  }

  const { complete, ...rest } = measured(task, reading);
  // Reaching step 3 with a task ID means the list exists and doesn't contain it.
  const listSaysIncomplete = !!task.hypixelTaskId && !task.hypixelTaskIdUnconfirmed && tasksList.available;

  // 2. A number that proves completion: exact, or a lower bound already past the requirement.
  if (complete && reading.confidence !== 'approx') {
    return { progress: { ...rest, status: 'verified_complete', likelyComplete: false }, clearTick: false };
  }
  // 3. Proven not done: an exact number short of the requirement, or absent from Hypixel's list.
  //    The API wins over a manual tick.
  if (reading.confidence === 'exact' || listSaysIncomplete) {
    return {
      progress: { ...rest, status: 'verified_incomplete', likelyComplete: false, remaining: complete ? null : rest.remaining },
      clearTick: ticked,
    };
  }
  // 4. Not provable either way.
  if (ticked) return { progress: { ...rest, status: 'ticked', likelyComplete: false }, clearTick: false };
  const reason = reading.confidence === 'lowerBound' ? 'At least this much; part of the progress is hidden' : 'Worked out from related data';
  return { progress: { ...rest, status: 'estimated', likelyComplete: complete, reason }, clearTick: false };
}

/** Evaluates every task in the catalogue for one profile. */
export function evaluateProgress(catalogue: Catalogue, profile: NormalizedProfile, ticks: ReadonlySet<string> = new Set()): Evaluation {
  const progress: TaskProgress[] = [];
  const ticksToClear: string[] = [];
  for (const task of catalogue.tasks) {
    const { progress: p, clearTick } = evaluateTask(task, profile, ticks.has(task.id));
    progress.push(p);
    if (clearTick) ticksToClear.push(task.id);
  }
  return { progress: applyAccess(progress, profile), ticksToClear };
}

export type TickDecision =
  | { ok: true }
  | { ok: false; why: 'already_complete' | 'api_incomplete'; progress: TaskProgress };

/**
 * Whether a manual tick makes sense: not for tasks the API already proves done,
 * and not for tasks it proves undone (the API would clear the tick straight away).
 */
export function decideTick(task: Task, profile: NormalizedProfile): TickDecision {
  const { progress } = evaluateTask(task, profile, false);
  if (progress.status === 'verified_complete') return { ok: false, why: 'already_complete', progress };
  if (progress.status === 'verified_incomplete') return { ok: false, why: 'api_incomplete', progress };
  return { ok: true };
}

export interface XpBuckets {
  /** Verified complete or ticked. */
  earned: number;
  /** Known to be left: verified incomplete, or estimated and not likely complete. */
  remaining: number;
  /** Estimated as done but not verified. */
  likelyComplete: number;
  /** No data: unavailable tasks. */
  unknown: number;
}

export interface CategorySummary extends XpBuckets {
  counts: Record<Status, number>;
  /** Distinct reasons given for this category's unavailable tasks. */
  unavailableReasons: Set<string>;
}

export interface ProgressSummary extends CategorySummary {
  byCategory: Map<string, CategorySummary>;
}

const emptyCounts = (): Record<Status, number> => Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
const emptyBuckets = (): CategorySummary => ({
  earned: 0, remaining: 0, likelyComplete: 0, unknown: 0, counts: emptyCounts(), unavailableReasons: new Set(),
});

function add(b: CategorySummary, p: TaskProgress): void {
  b.counts[p.status]++;
  const xp = p.task.xp;
  if (p.status === 'verified_complete' || p.status === 'ticked') b.earned += xp;
  else if (p.status === 'unavailable') {
    b.unknown += xp;
    if (p.reason) b.unavailableReasons.add(p.reason);
  }
  else if (p.likelyComplete) b.likelyComplete += xp;
  else b.remaining += xp;
}

/**
 * Totals for /xp overview. Monetary tasks never count toward eligible XP,
 * and neither do categories or sources the user excluded with /xp exclude.
 */
export function summarize(
  progress: TaskProgress[],
  excludedCategories: ReadonlySet<string> = new Set(),
  excludedSources: ReadonlySet<string> = new Set(),
): ProgressSummary {
  const total = emptyBuckets();
  const byCategory = new Map<string, CategorySummary>();
  for (const p of progress) {
    if (p.task.monetary || excludedCategories.has(p.task.category) || excludedSources.has(p.task.group ?? p.task.id)) continue;
    add(total, p);
    let cat = byCategory.get(p.task.category);
    if (!cat) byCategory.set(p.task.category, (cat = emptyBuckets()));
    add(cat, p);
  }
  return { ...total, byCategory };
}
