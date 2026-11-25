import type { EstimateContext } from '../estimate/estimate.js';
import type { NormalizedProfile } from '../profile/types.js';
import type { Catalogue } from '../tasks/catalogue.js';
import { summarize, type CategorySummary, type TaskProgress } from '../tasks/progress.js';
import { rankTasks, type RankResult } from './rank.js';

export interface CategoryView {
  category: string;
  summary: CategorySummary | undefined;
  /** Next tier of every source that can be worked on now, quickest first. */
  result: RankResult;
  /** Open sources left out because the user excluded them. */
  hiddenSources: number;
}

/**
 * Remaining tasks in one category: the same rules as /xp optimize, but every
 * other category is set aside instead of being ranked against it. Prerequisites
 * in other categories (a minion's collection unlock) still count.
 */
export function categoryView(
  catalogue: Catalogue,
  progress: TaskProgress[],
  profile: NormalizedProfile,
  ctx: EstimateContext,
  category: string,
  excludedSources: ReadonlySet<string> = new Set(),
): CategoryView {
  const others = new Set(catalogue.meta.categories.map((c) => c.id).filter((c) => c !== category));
  const result = rankTasks(progress, profile, ctx, { excluded: others, limit: Number.MAX_SAFE_INTEGER });
  // "excluded" counted the other categories; this view only cares about its own.
  result.dropped.excluded = 0;
  // Sources the user excluded are hidden here (unlike a whole excluded category, which this view exists to show).
  const before = result.ranked.length;
  result.ranked = result.ranked.filter((r) => !excludedSources.has(r.progress.task.group ?? r.progress.task.id));
  const hiddenSources = before - result.ranked.length;
  const own = progress.filter((p) => p.task.category === category);
  return { category, summary: summarize(own, new Set(), excludedSources).byCategory.get(category), result, hiddenSources };
}

/** Readable name for a metric, from the first task that uses it ("Combat level 43" -> "Combat"). */
export function metricLabel(catalogue: Catalogue, metric: string): string {
  const t = catalogue.tasks.find((x) => x.requires.metric === metric);
  if (!t) return metric;
  return t.group ? sourceName(t.name) : t.name;
}

/** A tiered task's name without its tier: "Combat level 43" -> "Combat", "Wheat collection X" -> "Wheat collection". */
export function sourceName(name: string): string {
  return name
    .replace(/\s+(level\s+\d+|[IVXL]+|\d+|exchange\s+\d+|milestone\s+\d+)$/i, '')
    .replace(/\s+level$/i, '')
    .trim();
}
