import type { Catalogue } from './catalogue.js';
import type { CategoryStatus, Tracking } from './types.js';

export interface CoverageRow {
  id: string;
  name: string;
  status: CategoryStatus;
  guide: string;
  tasks: number;
  xp: number;
  tracking: Record<Tracking, number>;
  wikiMaxXp?: number;
  note?: string;
}

export interface CoverageGuide {
  id: string;
  name: string;
  catalogueXp: number;
  maxXp: number | null;
  wikiEstimate: number | null;
}

export interface CoverageTotal {
  catalogueXp: number;
  /** Sum of in-game maxima; null unless every guide category has one. */
  knownTotal: number | null;
  /** Sum of wiki estimates where maxXp is unknown; null if any category has neither. */
  estimatedTotal: number | null;
  /** Share of the total the catalogue covers, or null when no total is available. */
  percent: number | null;
  /** True when percent rests on estimates rather than in-game maxima. */
  approximate: boolean;
}

export interface Coverage {
  checked: string;
  rows: CoverageRow[];
  guides: CoverageGuide[];
  total: CoverageTotal;
}

const STATUS_ORDER: Record<CategoryStatus, number> = { v1: 0, later: 1, never: 2 };

/** Builds the coverage report purely from the catalogue and meta.json. */
export function buildCoverage(catalogue: Catalogue): Coverage {
  const rows: CoverageRow[] = catalogue.meta.categories.map((c) => {
    const tasks = catalogue.byCategory.get(c.id) ?? [];
    const tracking: Record<Tracking, number> = { api: 0, manual: 0, none: 0 };
    for (const t of tasks) tracking[t.tracking]++;
    return {
      id: c.id, name: c.name, status: c.status, guide: c.guide,
      tasks: tasks.length, xp: tasks.reduce((a, t) => a + t.xp, 0), tracking,
      wikiMaxXp: c.wikiMaxXp, note: c.note,
    };
  });
  rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.xp - a.xp);

  const guides: CoverageGuide[] = catalogue.meta.guideCategories.map((g) => ({
    id: g.id, name: g.name, maxXp: g.maxXp, wikiEstimate: g.wikiEstimate,
    catalogueXp: rows.filter((r) => r.guide === g.id).reduce((a, r) => a + r.xp, 0),
  }));

  const catalogueXp = rows.reduce((a, r) => a + r.xp, 0);
  const allKnown = guides.every((g) => g.maxXp !== null);
  const knownTotal = allKnown ? guides.reduce((a, g) => a + g.maxXp!, 0) : null;
  const allEstimable = guides.every((g) => g.maxXp !== null || g.wikiEstimate !== null);
  const estimatedTotal = allEstimable ? guides.reduce((a, g) => a + (g.maxXp ?? g.wikiEstimate!), 0) : null;
  const base = knownTotal ?? estimatedTotal;

  let percent: number | null = null;
  if (base) {
    percent = Math.floor((catalogueXp / base) * 1000) / 10;
    // 100% only when every known task is catalogued: an exact in-game total, fully met.
    if (percent >= 100 && !(knownTotal !== null && catalogueXp >= knownTotal)) percent = 99.9;
    percent = Math.min(percent, 100);
  }
  return {
    checked: catalogue.meta.checked,
    rows,
    guides,
    total: { catalogueXp, knownTotal, estimatedTotal, percent, approximate: knownTotal === null },
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** One line per category, shared by the CLI and the Discord embed. */
export function formatRow(r: CoverageRow): string {
  if (r.tasks === 0) return `${r.name} · ${r.status === 'never' ? 'excluded (monetary)' : 'not catalogued yet'}`;
  const tracked = (['api', 'manual', 'none'] as const).filter((k) => r.tracking[k]).map((k) => `${k} ${fmt(r.tracking[k])}`).join(', ');
  const wiki = r.wikiMaxXp !== undefined && r.wikiMaxXp !== r.xp ? ` (wiki says ${fmt(r.wikiMaxXp)})` : '';
  return `${r.name} · ${fmt(r.tasks)} tasks · ${fmt(r.xp)} XP${wiki} · ${tracked}`;
}

export function formatTotal(t: CoverageTotal, checked: string): string {
  if (t.percent === null) {
    return `Catalogue: ${fmt(t.catalogueXp)} XP. SkyBlock XP total unknown: some categories have no in-game max or estimate yet (data/meta.json).`;
  }
  const total = t.knownTotal ?? t.estimatedTotal!;
  const approx = t.approximate ? '~' : '';
  const why = t.approximate ? ' Total is a wiki estimate until the in-game maxima are entered in data/meta.json.' : '';
  return `Catalogue: ${fmt(t.catalogueXp)} of ${approx}${fmt(total)} XP (${approx}${t.percent}%), checked ${checked}.${why}`;
}

export function formatCoverageText(c: Coverage): string {
  const sections: string[] = [];
  for (const status of ['v1', 'later', 'never'] as const) {
    const rows = c.rows.filter((r) => r.status === status);
    if (!rows.length) continue;
    const label = status === 'v1' ? 'In v1' : status === 'later' ? 'Later versions' : 'Never (monetary)';
    sections.push(`${label}\n${rows.map((r) => `  ${formatRow(r)}`).join('\n')}`);
  }
  const guides = c.guides.map((g) => {
    const max = g.maxXp !== null ? fmt(g.maxXp) : g.wikiEstimate !== null ? `~${fmt(g.wikiEstimate)}` : '?';
    return `  ${g.name}: ${fmt(g.catalogueXp)} / ${max}`;
  });
  sections.push(`By SkyBlock Guide category\n${guides.join('\n')}`);
  sections.push(formatTotal(c.total, c.checked));
  return sections.join('\n\n');
}
