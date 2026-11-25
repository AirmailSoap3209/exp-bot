import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RateBook } from '../estimate/rates.js';
import { BRACKET_NAMES, type Bracket, type Range } from '../estimate/types.js';
import { DATA_DIR, type Catalogue } from '../tasks/catalogue.js';

/** Something else one unit of the primary activity also gives, e.g. Farming XP per wheat. */
export interface ComboYield {
  metric: string;
  /** Amount per one unit of the primary's rate ("items/min" -> per item), as a range; per bracket when it depends on gear. */
  per: Range | Record<Bracket, Range>;
  /** Where the number came from. */
  basis: string;
}

/**
 * One in-game action that progresses several sources at once (data/combos/*.json).
 * The primary is an existing activity, so its rate (session, override or bracket default) is reused;
 * every other yield is a ratio to the primary's unit.
 */
export interface Combo {
  id: string;
  name: string;
  location?: string;
  primary: string;
  /** Metrics the primary activity itself advances (from the tasks that use it). */
  primaryMetrics: string[];
  yields: ComboYield[];
  /** The file's source note. */
  source: string;
}

export class ComboError extends Error {
  constructor(readonly problems: string[]) {
    super(`Combo data is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  ${problems.slice(0, 25).join('\n  ')}`);
    this.name = 'ComboError';
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isRange = (v: unknown): v is Range =>
  Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0) && v[0] <= v[1];

/** The yield's range for a bracket. */
export function yieldPer(y: ComboYield, bracket: Bracket): Range {
  return Array.isArray(y.per) ? y.per : y.per[bracket];
}

/**
 * Checks combo files against the catalogue and rates. Returns the combos and every problem found:
 * shape, duplicate IDs, a primary with no rate or no tasks, yield metrics no task uses, a yield
 * that repeats the primary's own metric, and bad ranges.
 */
export function buildCombos(files: { name: string; data: unknown }[], catalogue: Catalogue, book: RateBook): { combos: Combo[]; problems: string[] } {
  const problems: string[] = [];
  const combos: Combo[] = [];
  const metrics = new Set(catalogue.tasks.map((t) => t.requires.metric));
  const seen = new Set<string>();

  for (const { name: file, data } of files) {
    const f = data as { source?: unknown; combos?: unknown };
    if (!f || typeof f !== 'object' || !isStr(f.source) || !Array.isArray(f.combos)) {
      problems.push(`${file}: must be { source: string, combos: [...] }`);
      continue;
    }
    f.combos.forEach((raw, i) => {
      const c = raw as Record<string, unknown>;
      const at = `${file}[${i}] ${isStr(c?.id) ? c.id : '(no id)'}`;
      const p: string[] = [];
      if (!isStr(c?.id) || !c.id.startsWith('combo.')) p.push(`${at}: id must be a string starting with "combo."`);
      else if (seen.has(c.id)) p.push(`${at}: duplicate id`);
      if (!isStr(c?.name)) p.push(`${at}: name must be a non-empty string`);
      if (c?.location !== undefined && !isStr(c.location)) p.push(`${at}: location must be a non-empty string when present`);

      const primary = c?.primary;
      let primaryMetrics: string[] = [];
      if (!isStr(primary)) p.push(`${at}: primary must be an activity ID`);
      else {
        if (!book.rates.has(primary)) p.push(`${at}: primary ${primary} has no rate (unknown, or a fixed-time activity)`);
        primaryMetrics = [...new Set(catalogue.tasks.filter((t) => t.activity === primary && !t.monetary).map((t) => t.requires.metric))];
        if (!primaryMetrics.length) p.push(`${at}: no task uses primary ${primary}`);
      }

      const yields: ComboYield[] = [];
      if (!Array.isArray(c?.yields) || !c.yields.length) p.push(`${at}: yields must be a non-empty array`);
      else {
        const ym = new Set<string>();
        for (const y of c.yields as Record<string, unknown>[]) {
          const m = y?.metric;
          if (!isStr(m)) { p.push(`${at}: each yield needs a metric`); continue; }
          if (!metrics.has(m)) p.push(`${at}: yield metric ${m} isn't used by any task`);
          if (primaryMetrics.includes(m)) p.push(`${at}: yield ${m} is the primary's own metric`);
          if (ym.has(m)) p.push(`${at}: yield ${m} is listed twice`);
          ym.add(m);
          const per = y.per;
          const ok = isRange(per) || (typeof per === 'object' && per !== null && !Array.isArray(per) &&
            BRACKET_NAMES.every((b) => isRange((per as Record<string, unknown>)[b])));
          if (!ok) p.push(`${at}: yield ${m} per must be [low, high] or { early, mid, late } ranges, all > 0 with low <= high`);
          if (!isStr(y.basis)) p.push(`${at}: yield ${m} needs a basis`);
          if (ok && isStr(y.basis)) yields.push({ metric: m, per: per as ComboYield['per'], basis: y.basis });
        }
      }

      problems.push(...p);
      if (!p.length) {
        seen.add(c.id as string);
        combos.push({
          id: c.id as string, name: c.name as string, ...(isStr(c.location) ? { location: c.location } : {}),
          primary: primary as string, primaryMetrics, yields, source: f.source as string,
        });
      }
    });
  }
  return { combos: combos.sort((a, b) => a.id.localeCompare(b.id)), problems };
}

/** Loads data/combos/*.json; throws ComboError if anything is wrong, like the catalogue. */
export function loadCombos(catalogue: Catalogue, book: RateBook, dir = join(DATA_DIR, 'combos')): Combo[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((name) => ({ name: `combos/${name}`, data: JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown }));
  const { combos, problems } = buildCombos(files, catalogue, book);
  if (problems.length) throw new ComboError(problems);
  return combos;
}
