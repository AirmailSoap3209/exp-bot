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
  const entry = ctx.book.rates.get(task.activity);
  if (!entry) return undefined;

  const amount = p.remaining ?? p.required;
  const unit = entry.unit.replace(/\/min$/, '');
  // Activities that pay out per boss or per run never take less than one (entry.minMinutes),
  // taken from the bracket in use, or the profile's bracket for measured and typed rates.
  const toMinutes = (rate: Range, bracket?: Bracket): Range => {
    const m: Range = [amount / rate[1], amount / rate[0]];
    if (!entry.minMinutes) return m;
    const floor = entry.minMinutes[bracket ?? resolveBracket(entry.bracketBy, profile, ctx.book.brackets).bracket];
    return [Math.max(m[0], floor[0]), Math.max(m[1], floor[1])];
  };

  const session = ctx.sessionRates?.[task.activity];
  if (session && session > 0) {
    const rate = spread(session);
    return finish(toMinutes(rate), { source: 'session', unit, rate });
  }
  const override = ctx.overrides?.[task.activity];
  if (override) {
    if ('rate' in override) {
      const rate = spread(override.rate);
      return finish(toMinutes(rate), { source: 'override', unit, rate });
    }
    const bracket = override.bracket as Bracket;
    const rate = entry.brackets[bracket];
    if (rate) return finish(toMinutes(rate, bracket), { source: 'override', bracket, unit, rate });
  }
  const bracketInfo = resolveBracket(entry.bracketBy, profile, ctx.book.brackets);
  const rate = entry.brackets[bracketInfo.bracket];
  return finish(toMinutes(rate, bracketInfo.bracket), { source: 'default', bracket: bracketInfo.bracket, bracketInfo, unit, rate });
}
