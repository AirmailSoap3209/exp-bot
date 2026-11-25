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

/**
 * Every readable metric's value now, so the end of a session can see everything that moved,
 * including metrics no rated activity measures (HOTM XP, Garden XP).
 */
export function takeSnapshot(catalogue: Catalogue, _book: RateBook, p: NormalizedProfile): Record<string, number> {
  const out: Record<string, number> = {};
  const done = new Set<string>();
  for (const t of catalogue.tasks) {
    const m = t.requires.metric;
    if (done.has(m)) continue;
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

/** One combo yield measured in a session: how much of it came per unit of the primary. */
export interface RatioMeasurement {
  combo: string;
  metric: string;
  /** Yield change ÷ primary change over the session. */
  ratio: number;
  delta: number;
}

/**
 * For every combo built on the session's activity, each yield's change per unit of the primary.
 * Yields that didn't move, or aren't visible in both snapshots, aren't measured: zero usually
 * means the API hadn't caught up or the yield is off for this profile, not a true zero.
 */
export function measureRatios(
  combos: readonly { id: string; primary: string; yields: readonly { metric: string }[] }[],
  activity: string,
  start: Record<string, number>,
  end: Record<string, number>,
  primaryDelta: number,
): RatioMeasurement[] {
  if (!(primaryDelta > 0)) return [];
  const out: RatioMeasurement[] = [];
  for (const c of combos) {
    if (c.primary !== activity) continue;
    for (const y of c.yields) {
      const a = start[y.metric];
      const b = end[y.metric];
      if (a === undefined || b === undefined || b - a <= 0) continue;
      out.push({ combo: c.id, metric: y.metric, ratio: (b - a) / primaryDelta, delta: b - a });
    }
  }
  return out;
}

/** A session links a metric to its activity for scoring only once it has moved in this many sessions. */
export const LINK_MIN_SESSIONS = 2;

/** One metric that went up alongside the session's activity, per unit of the activity's own metric. */
export interface LinkMeasurement {
  metric: string;
  ratio: number;
  delta: number;
}

/**
 * Everything else that went up during a session, as a ratio to the activity's own metric (e.g.
 * Mining XP per Mithril mined). One session can't tell cause from coincidence (a minion, a co-op
 * mate, a second thing done on the side), so these become combo yields only after
 * LINK_MIN_SESSIONS sessions of the same activity; see withLearnedLinks.
 */
export function measureLinks(
  primaryMetric: string,
  start: Record<string, number>,
  end: Record<string, number>,
  primaryDelta: number,
): LinkMeasurement[] {
  if (!(primaryDelta > 0)) return [];
  return changes(start, end)
    .filter((c) => c.metric !== primaryMetric)
    .map((c) => ({ metric: c.metric, ratio: c.delta / primaryDelta, delta: c.delta }));
}

/** Metrics that moved, largest change first, for the end-of-session summary. */
export function changes(start: Record<string, number>, end: Record<string, number>): { metric: string; delta: number }[] {
  return Object.keys(end)
    .map((metric) => ({ metric, delta: (end[metric] ?? 0) - (start[metric] ?? 0) }))
    .filter((c) => c.delta > 0 && c.metric in start)
    .sort((a, b) => b.delta - a.delta);
}
