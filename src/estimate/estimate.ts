import type { NormalizedProfile } from '../profile/types.js';
import type { RateOverride } from '../storage/userData.js';
import type { TaskProgress } from '../tasks/progress.js';
import { resolveBracket, type BracketResult } from './brackets.js';
import type { RateBook } from './rates.js';
import type { Bracket, Range } from './types.js';

/** A single measured or typed rate becomes a range of ±15%, so every estimate stays a range. */
const SPREAD = 0.15;
const spread = (r: number): Range => [r * (1 - SPREAD), r * (1 + SPREAD)];

export type RateSource = 'fixed' | 'session' | 'override' | 'default';

export interface Estimate {
  minutes: Range;
  midMinutes: number;
  xpPerMin: number;
  source: RateSource;
  /** Bracket used, for override-by-bracket and default rates. */
  bracket?: Bracket;
  bracketInfo?: BracketResult;
  /** Progress unit, e.g. "kills" from "kills/min". */
  unit?: string;
  /** Rate range used, per minute. */
  rate?: Range;
  /** The API had no progress number, so the whole requirement is assumed left. */
  assumedNoProgress: boolean;
}

export interface EstimateContext {
  book: RateBook;
  /** Only for the linked profile. */
  overrides?: Record<string, RateOverride>;
  /** Measured rates per activity (step 7). Only for the linked profile. */
  sessionRates?: Record<string, number>;
}

/** The rate an activity runs at for this profile: session, then override, then bracket default. */
export interface ActivityRate {
  rate: Range;
  source: Exclude<RateSource, 'fixed'>;
  /** The override's bracket or the default's; undefined for a measured or typed number. */
  bracket?: Bracket;
  bracketInfo?: BracketResult;
  /** The bracket that gear-dependent numbers (minimum times, combo ratios) should use. */
  gearBracket: Bracket;
  unit: string;
}

export function activityRate(activity: string, profile: NormalizedProfile, ctx: EstimateContext): ActivityRate | undefined {
  const entry = ctx.book.rates.get(activity);
  if (!entry) return undefined;
  const unit = entry.unit.replace(/\/min$/, '');
  const profileBracket = () => resolveBracket(entry.bracketBy, profile, ctx.book.brackets);
  const session = ctx.sessionRates?.[activity];
  if (session && session > 0) return { rate: spread(session), source: 'session', gearBracket: profileBracket().bracket, unit };
  const override = ctx.overrides?.[activity];
  if (override) {
    if ('rate' in override) return { rate: spread(override.rate), source: 'override', gearBracket: profileBracket().bracket, unit };
    const bracket = override.bracket as Bracket;
    const rate = entry.brackets[bracket];
    if (rate) return { rate, source: 'override', bracket, gearBracket: bracket, unit };
  }
  const bracketInfo = profileBracket();
  return { rate: entry.brackets[bracketInfo.bracket], source: 'default', bracket: bracketInfo.bracket, bracketInfo, gearBracket: bracketInfo.bracket, unit };
}

/**
 * Minutes to produce `amount` of an activity's unit. Activities that pay out per boss or per run
 * never take less than one (entry.minMinutes, at the gear bracket).
 */
export function minutesFor(activity: string, amount: number, r: ActivityRate, ctx: EstimateContext): Range {
  const m: Range = [amount / r.rate[1], amount / r.rate[0]];
  const floor = ctx.book.rates.get(activity)?.minMinutes?.[r.gearBracket];
  return floor ? [Math.max(m[0], floor[0]), Math.max(m[1], floor[1])] : m;
}

/** Minutes for one task, or undefined when no rate covers its activity. */
export function estimateTask(p: TaskProgress, profile: NormalizedProfile, ctx: EstimateContext): Estimate | undefined {
  const task = p.task;
  const assumedNoProgress = p.remaining === null;
  const finish = (minutes: Range, rest: Omit<Estimate, 'minutes' | 'midMinutes' | 'xpPerMin' | 'assumedNoProgress'>): Estimate => {
    const mid = (minutes[0] + minutes[1]) / 2;
    return { minutes, midMinutes: mid, xpPerMin: task.xp / mid, assumedNoProgress, ...rest };
  };

  if (task.minutes) return finish(task.minutes, { source: 'fixed' });
  if (!task.activity) return undefined;
  const r = activityRate(task.activity, profile, ctx);
  if (!r) return undefined;
  const minutes = minutesFor(task.activity, p.remaining ?? p.required, r, ctx);
  return finish(minutes, {
    source: r.source, unit: r.unit, rate: r.rate,
    ...(r.bracket ? { bracket: r.bracket } : {}), ...(r.bracketInfo ? { bracketInfo: r.bracketInfo } : {}),
  });
}
