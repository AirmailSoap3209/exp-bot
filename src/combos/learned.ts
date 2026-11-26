import { spread } from '../estimate/estimate.js';
import type { RateBook } from '../estimate/rates.js';
import { linkStatus } from '../sessions/sessions.js';
import type { Catalogue } from '../tasks/catalogue.js';
import type { Combo, ComboYield } from './combos.js';

/** A blended link ratio, as sessions store it. */
export interface StoredLink {
  rate: number;
  sessions: number;
  /** Newest first; older files may lack it. */
  history?: readonly { rate: number }[];
}

/**
 * Combos with what the player's own sessions showed moving alongside each activity
 * (e.g. Mining XP while mining Mithril). A link counts once linkStatus says it's ready (moved in
 * LINK_MIN_SESSIONS sessions with ratios that agree):
 *  - on an activity that already has a combo, it's added as another yield (data yields keep their
 *    own measured ratio, from the combo ratios);
 *  - on an activity with no combo, it makes a new one, "<activity> (from your sessions)".
 * Learned yields use the blended ratio ±15%, like measured rates, and are marked `learned`.
 * Links to metrics no task uses, to the activity's own metric, or that the player ignored
 * (/xp session ignore) are left out.
 */
export function withLearnedLinks(
  combos: readonly Combo[],
  links: Record<string, Record<string, StoredLink>>,
  catalogue: Catalogue,
  book: RateBook,
  labelOf: (activity: string) => string,
  ignored: ReadonlySet<string> = new Set(),
): Combo[] {
  const used = new Set(catalogue.tasks.map((t) => t.requires.metric));
  const out = combos.map((c) => ({ ...c, yields: [...c.yields] }));
  for (const [activity, byMetric] of Object.entries(links)) {
    if (!book.rates.has(activity)) continue;
    const own = [...new Set(catalogue.tasks.filter((t) => t.activity === activity && !t.monetary).map((t) => t.requires.metric))];
    if (!own.length) continue;
    const learned: ComboYield[] = Object.entries(byMetric)
      .filter(([metric, l]) => linkStatus(l) === 'ready' && used.has(metric) && !own.includes(metric) && !ignored.has(metric))
      .map(([metric, l]) => ({ metric, per: spread(l.rate), basis: `measured in ${l.sessions} of your sessions`, learned: true }));
    if (!learned.length) continue;
    const existing = out.filter((c) => c.primary === activity);
    if (existing.length) {
      for (const c of existing) c.yields.push(...learned.filter((y) => !c.yields.some((x) => x.metric === y.metric)));
    } else {
      out.push({ id: `combo.learned.${activity}`, name: `${labelOf(activity)} (from your sessions)`, primary: activity, primaryMetrics: own, yields: learned, source: 'your sessions' });
    }
  }
  return out;
}
