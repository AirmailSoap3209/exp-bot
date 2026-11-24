import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../tasks/catalogue.js';
import { validateRate, type BracketConfig, type RateEntry } from './types.js';

export interface RateBook {
  rates: Map<string, RateEntry>;
  brackets: BracketConfig;
}

/**
 * Loads data/rates/: brackets.json, every generated rate file, then overrides.json on top.
 * Throws on any invalid entry, like the task catalogue.
 */
export function loadRates(dataDir = DATA_DIR): RateBook {
  const dir = join(dataDir, 'rates');
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
  const brackets = read('brackets.json') as BracketConfig;
  const rates = new Map<string, RateEntry>();
  const problems: string[] = [];
  const add = (list: unknown, file: string) => {
    if (!Array.isArray(list)) return problems.push(`rates/${file}: must be an array`);
    list.forEach((r, i) => {
      const p = validateRate(r, `rates/${file}[${i}]`);
      problems.push(...p);
      if (!p.length) rates.set((r as RateEntry).activity, r as RateEntry);
    });
  };
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'brackets.json' && f !== 'overrides.json').sort()) {
    add(read(f), f);
  }
  add((read('overrides.json') as { rates: unknown }).rates, 'overrides.json');
  for (const r of rates.values()) {
    if (!brackets.groups[r.bracketBy] && !/^(skill|slayer)\.[a-z]+$|^catacombs$/.test(r.bracketBy)) {
      problems.push(`${r.activity}: unknown bracketBy "${r.bracketBy}"`);
    }
  }
  if (problems.length) throw new Error(`Rate data is invalid:\n  ${problems.slice(0, 20).join('\n  ')}`);
  return { rates, brackets };
}
