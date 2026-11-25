import type { TaskProgress } from '../tasks/progress.js';
import type { Task } from '../tasks/types.js';
import { dropReason, isDone, type Exclusions } from './eligible.js';

export interface MetricDelta {
  metric: string;
  from: number;
  to: number;
}

export interface ApplyResult {
  /** Tasks that finished because of this step, prerequisites first. Never a task finished earlier. */
  newlyCompleted: Task[];
  metricChanges: MetricDelta[];
}

/**
 * A simulated copy of a profile's progress, shared by /xp optimize and /xp target.
 *
 * - Metric values start from the profile and only move through apply().
 * - A task completes once: when its metric meets the requirement and every
 *   prerequisite is complete. A task whose metric is met while a prerequisite
 *   is still open waits and completes the moment the prerequisite does.
 * - Unavailable and blocked tasks (no data, skill caps) never complete here.
 * - Exclusions don't stop a task completing; they only stop it being offered
 *   as a candidate. Real progress on an excluded source still unlocks its dependents.
 */
export class PlanState {
  // Shared between clones (never modified after construction).
  private byId = new Map<string, TaskProgress>();
  /** Tasks per metric, lowest requirement first, so tiers complete in order. */
  private byMetric = new Map<string, Task[]>();
  private dependents = new Map<string, Task[]>();
  // Per clone.
  private values = new Map<string, number>();
  /** Metrics apply() has moved; tasks on other metrics keep their original progress. */
  private touched = new Set<string>();
  private completed = new Set<string>();

  constructor(progress: readonly TaskProgress[]) {
    for (const p of progress) {
      this.byId.set(p.task.id, p);
      const m = p.task.requires.metric;
      let list = this.byMetric.get(m);
      if (!list) this.byMetric.set(m, (list = []));
      list.push(p.task);
      // Tiers share a metric; take the highest known reading.
      if (p.current !== null) this.values.set(m, Math.max(this.values.get(m) ?? 0, p.current));
      for (const pre of p.task.prerequisites) {
        let deps = this.dependents.get(pre);
        if (!deps) this.dependents.set(pre, (deps = []));
        deps.push(p.task);
      }
      if (isDone(p)) this.completed.add(p.task.id);
    }
    for (const list of this.byMetric.values()) list.sort((a, b) => a.requires.amount - b.requires.amount);
  }

  /** An independent copy; changes to either don't affect the other. */
  clone(): PlanState {
    const c = new PlanState([]);
    c.byId = this.byId;
    c.byMetric = this.byMetric;
    c.dependents = this.dependents;
    c.values = new Map(this.values);
    c.touched = new Set(this.touched);
    c.completed = new Set(this.completed);
    return c;
  }

  get completedTaskIds(): ReadonlySet<string> {
    return this.completed;
  }

  isComplete(taskId: string): boolean {
    return this.completed.has(taskId);
  }

  /** Current simulated value of a metric, or undefined when the profile had no number for it and nothing moved it. */
  value(metric: string): number | undefined {
    return this.values.get(metric);
  }

  /** Amount still needed for a task; the whole requirement when the metric is unknown. */
  remainingFor(task: Task): number {
    if (this.completed.has(task.id)) return 0;
    return Math.max(0, task.requires.amount - (this.values.get(task.requires.metric) ?? 0));
  }

  /**
   * The task's progress as the estimator should see it. Unchanged until apply()
   * moves its metric, so a fresh state estimates exactly like /xp optimize does.
   */
  progressFor(taskId: string): TaskProgress | undefined {
    const p = this.byId.get(taskId);
    if (!p || !this.touched.has(p.task.requires.metric) || this.completed.has(taskId)) return p;
    const current = this.values.get(p.task.requires.metric) ?? 0;
    return { ...p, current, remaining: Math.max(0, p.required - current) };
  }

  /** Whether a task could be worked on now: open, has data, not blocked, prerequisites complete. */
  isAvailable(taskId: string): boolean {
    const p = this.byId.get(taskId);
    return !!p && dropReason(p, (id) => this.completed.has(id), {}, this.completed.has(taskId)) === undefined;
  }

  /**
   * Tasks to offer: available, not monetary, not excluded, and only the lowest
   * open tier of each source (prerequisite chains already ensure that; this
   * guards sources without a chain). Returned as the estimator should see them.
   */
  candidates(ex: Exclusions = {}): TaskProgress[] {
    const lowest = new Map<string, TaskProgress>();
    const ungrouped: TaskProgress[] = [];
    for (const p of this.byId.values()) {
      if (dropReason(p, (id) => this.completed.has(id), ex, this.completed.has(p.task.id))) continue;
      const g = p.task.group;
      if (!g) ungrouped.push(p);
      else {
        const cur = lowest.get(g);
        if (!cur || (p.task.tier ?? 0) < (cur.task.tier ?? 0)) lowest.set(g, p);
      }
    }
    return [...lowest.values(), ...ungrouped].map((p) => this.progressFor(p.task.id)!);
  }

  /**
   * The next task on a metric that could be offered now (lowest open requirement first),
   * as the estimator should see it; undefined when none is available or allowed.
   */
  nextOpen(metric: string, ex: Exclusions = {}): TaskProgress | undefined {
    for (const t of this.byMetric.get(metric) ?? []) {
      if (this.completed.has(t.id)) continue;
      const p = this.byId.get(t.id)!;
      if (!dropReason(p, (id) => this.completed.has(id), ex, false)) return this.progressFor(t.id);
    }
    return undefined;
  }

  /** What apply() would do, without changing anything. */
  tryApply(deltas: Readonly<Record<string, number>>): ApplyResult {
    const saved = Object.keys(deltas).map((m) => ({ m, value: this.values.get(m), touched: this.touched.has(m) }));
    const result = this.apply(deltas);
    for (const t of result.newlyCompleted) this.completed.delete(t.id);
    for (const s of saved) {
      if (s.value === undefined) this.values.delete(s.m);
      else this.values.set(s.m, s.value);
      if (!s.touched) this.touched.delete(s.m);
    }
    return result;
  }

  /** Adds amounts to metrics and completes whatever that finishes, including unlocked dependents. */
  apply(deltas: Readonly<Record<string, number>>): ApplyResult {
    const metricChanges: MetricDelta[] = [];
    const check: Task[] = [];
    for (const [metric, amount] of Object.entries(deltas)) {
      if (!(amount > 0)) continue;
      const from = this.values.get(metric) ?? 0;
      this.values.set(metric, from + amount);
      this.touched.add(metric);
      metricChanges.push({ metric, from, to: from + amount });
      check.push(...(this.byMetric.get(metric) ?? []));
    }
    return { newlyCompleted: this.settle(check), metricChanges };
  }

  /**
   * Does one task: adds exactly what it still needs to its metric (an unknown
   * metric counts from 0, matching the estimate). If the metric is already met,
   * nothing moves and the task completes as long as it can.
   */
  applyTask(taskId: string): ApplyResult {
    const p = this.byId.get(taskId);
    if (!p || this.completed.has(taskId)) return { newlyCompleted: [], metricChanges: [] };
    const need = this.remainingFor(p.task);
    if (need > 0) return this.apply({ [p.task.requires.metric]: need });
    return { newlyCompleted: this.settle([p.task]), metricChanges: [] };
  }

  /**
   * Completes every task in `queue` that is now met, then its dependents, until
   * nothing changes. Each task completes at most once, so this always ends,
   * even on bad data (the catalogue loader already rejects prerequisite cycles).
   */
  private settle(queue: Task[]): Task[] {
    const done: Task[] = [];
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i]!;
      if (this.completed.has(t.id) || !this.canComplete(t)) continue;
      this.completed.add(t.id);
      done.push(t);
      queue.push(...(this.dependents.get(t.id) ?? []));
    }
    return done;
  }

  private canComplete(t: Task): boolean {
    const p = this.byId.get(t.id);
    if (!p || p.status === 'unavailable' || p.blocked) return false;
    if (!t.prerequisites.every((id) => this.completed.has(id))) return false;
    // Tolerance for fractional rates adding up to just under a whole requirement.
    return (this.values.get(t.requires.metric) ?? 0) >= t.requires.amount - 1e-9;
  }
}
