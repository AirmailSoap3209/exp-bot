/**
 * Lists every combo in data/combos/ with what it advances, for review.
 *
 *   npm run combos
 */
import { loadCombos, yieldPer } from '../src/combos/combos.js';
import { loadRates } from '../src/estimate/rates.js';
import { BRACKET_NAMES } from '../src/estimate/types.js';
import { loadCatalogue } from '../src/tasks/catalogue.js';

const catalogue = loadCatalogue();
const book = loadRates();
const combos = loadCombos(catalogue, book);
const tasksOn = (metric: string) => catalogue.tasks.filter((t) => t.requires.metric === metric && !t.monetary);
const fmt = (n: number) => Number(n.toPrecision(3)).toLocaleString('en-US');

console.log(`${combos.length} combos\n`);
for (const c of combos) {
  const unit = book.rates.get(c.primary)!.unit.replace(/\/min$/, '');
  console.log(`${c.id} · ${c.name}${c.location ? ` · ${c.location}` : ''}`);
  console.log(`  primary ${c.primary} (${unit}): ${c.primaryMetrics.map((m) => `${m} [${tasksOn(m).length} tasks]`).join(', ')}`);
  for (const y of c.yields) {
    const per = BRACKET_NAMES.map((b) => `${b} ${yieldPer(y, b).map(fmt).join('-')}`).join(' · ');
    console.log(`  + ${y.metric} [${tasksOn(y.metric).length} tasks] per ${unit.replace(/s$/, '')}: ${Array.isArray(y.per) ? y.per.map(fmt).join('-') : per}`);
    console.log(`    ${y.basis}`);
  }
}
