import type { RateBook } from '../estimate/rates.js';
import type { NormalizedProfile } from '../profile/types.js';
import type { Catalogue } from '../tasks/catalogue.js';
import { METRIC_VALUES } from '../tasks/readers/values.js';

/** The API lags play by a few minutes, so shorter sessions measure mostly lag. */
export const MIN_SESSION_MINUTES = 15;
/** Sessions left open longer are probably forgotten; they expire without saving. */
export const MAX_SESSION_MINUTES = 4 * 60;
/** Weight of the newest session when blending: new rate counts 60%, everything before 40%. */
export const BLEND_WEIGHT = 0.6;
const HISTORY_LIMIT = 20;

export interface SessionRate {
  /** Blended rate, in the activity's unit per minute. */
  rate: number;
  sessions: number;
  history: { rate: number; minutes: number; endedAt: string }[];
}

/** The metric an activity's tasks measure, and the category that reads it. */
export function activityMetric(catalogue: Catalogue, activity: string): { metric: string; category: string } | undefined {
  const t = catalogue.tasks.find((x) => x.activity === activity);
  return t ? { metric: t.requires.metric, category: t.category } : undefined;
}

/** Activities a session can measure: they have a rate and a readable metric. */
export function measurableActivities(catalogue: Catalogue, book: RateBook): Set<string> {
  const out = new Set<string>();
  for (const t of catalogue.tasks) if (t.activity && book.rates.has(t.activity) && METRIC_VALUES[t.category]) out.add(t.activity);
  return out;
}

export function metricValue(category: string, metric: string, p: NormalizedProfile): number | undefined {
  return METRIC_VALUES[category]?.(metric, p);
}

/** Every measurable metric's value now, so the end of a session can show everything that moved. */
export function takeSnapshot(catalogue: Catalogue, book: RateBook, p: NormalizedProfile): Record<string, number> {
  const out: Record<string, number> = {};
  const done = new Set<string>();
  for (const t of catalogue.tasks) {
    const m = t.requires.metric;
    if (done.has(m) || !t.activity || !book.rates.has(t.activity)) continue;
    done.add(m);
    const v = metricValue(t.category, m, p);
    if (v !== undefined) out[m] = v;
  }
  return out;
}

export type Measurement =
  | { ok: true; delta: number; minutes: number; rate: number }
  | { ok: false; reason: 'too_short' | 'expired' | 'no_data' | 'no_progress'; minutes: number };

/** Change in the activity's metric per minute between two snapshots. */
export function measure(metric: string, start: Record<string, number>, end: Record<string, number>, minutes: number): Measurement {
  if (minutes > MAX_SESSION_MINUTES) return { ok: false, reason: 'expired', minutes };
  if (minutes < MIN_SESSION_MINUTES) return { ok: false, reason: 'too_short', minutes };
  const a = start[metric];
  const b = end[metric];
  if (a === undefined || b === undefined) return { ok: false, reason: 'no_data', minutes };
  const delta = b - a;
  if (delta <= 0) return { ok: false, reason: 'no_progress', minutes };
  return { ok: true, delta, minutes, rate: delta / minutes };
}

/** Blends a new measurement into earlier ones, favouring the newest. */
export function blend(previous: SessionRate | undefined, rate: number, minutes: number, endedAt: string): SessionRate {
  const blended = previous ? BLEND_WEIGHT * rate + (1 - BLEND_WEIGHT) * previous.rate : rate;
  return {
    rate: blended,
    sessions: (previous?.sessions ?? 0) + 1,
    history: [{ rate, minutes, endedAt }, ...(previous?.history ?? [])].slice(0, HISTORY_LIMIT),
  };
}

/** Metrics that moved, largest change first, for the end-of-session summary. */
export function changes(start: Record<string, number>, end: Record<string, number>): { metric: string; delta: number }[] {
  return Object.keys(end)
    .map((metric) => ({ metric, delta: (end[metric] ?? 0) - (start[metric] ?? 0) }))
    .filter((c) => c.delta > 0 && c.metric in start)
    .sort((a, b) => b.delta - a.delta);
}
