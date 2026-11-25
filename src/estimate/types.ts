export const BRACKET_NAMES = ['early', 'mid', 'late'] as const;
export type Bracket = (typeof BRACKET_NAMES)[number];
export type Range = [number, number];

/** One activity's rate: amount per minute, low and high, for each bracket. */
export interface RateEntry {
  activity: string;
  /** "<thing>/min"; the part before "/min" names the task's progress unit. */
  unit: string;
  brackets: Record<Bracket, Range>;
  /** A bracket group ("combat", "dungeons") or one input ("skill.farming", "slayer.zombie", "catacombs"). */
  bracketBy: string;
  /** Shortest a task on this activity can take, per bracket: one boss, one run. Estimates never go below it. */
  minMinutes?: Record<Bracket, Range>;
  source?: string;
}

export interface BracketConfig {
  cutoffs: Record<string, [number, number]>;
  groups: Record<string, { inputs: string[]; combine: 'min' | 'max' }>;
}

/** Checks a rate entry's shape; returns problems. */
export function validateRate(raw: unknown, where: string): string[] {
  const p: string[] = [];
  const r = raw as Partial<RateEntry> | null;
  if (!r || typeof r !== 'object') return [`${where}: not an object`];
  const at = `${where} ${r.activity ?? '(no activity)'}`;
  if (typeof r.activity !== 'string' || !r.activity) p.push(`${at}: activity must be a string`);
  if (typeof r.unit !== 'string' || !r.unit.endsWith('/min')) p.push(`${at}: unit must end in "/min"`);
  if (typeof r.bracketBy !== 'string' || !r.bracketBy) p.push(`${at}: bracketBy must be a string`);
  for (const b of BRACKET_NAMES) {
    const range = r.brackets?.[b];
    if (!Array.isArray(range) || range.length !== 2 || !range.every((x) => typeof x === 'number' && x > 0) || range[0] > range[1]) {
      p.push(`${at}: brackets.${b} must be [low, high] with 0 < low <= high`);
    }
    if (r.minMinutes !== undefined) {
      const m = r.minMinutes[b];
      if (!Array.isArray(m) || m.length !== 2 || !m.every((x) => typeof x === 'number' && x > 0) || m[0] > m[1]) {
        p.push(`${at}: minMinutes.${b} must be [low, high] with 0 < low <= high`);
      }
    }
  }
  return p;
}
