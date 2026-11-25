import { sourceName } from '../optimizer/category.js';
import type { Catalogue } from './catalogue.js';
import type { Task } from './types.js';

export interface Choice {
  name: string;
  value: string;
}

/** Discord autocomplete limits. */
const MAX_CHOICES = 25;
const MAX_LEN = 100;
const clip = (s: string) => (s.length > MAX_LEN ? s.slice(0, MAX_LEN - 1) + '…' : s);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Lower is better; undefined means no match. Every query word must match the start of some word. */
function score(text: string, query: string[]): number | undefined {
  if (!query.length) return 0;
  const w = words(text);
  let total = 0;
  for (const q of query) {
    const i = w.findIndex((x) => x.startsWith(q));
    if (i < 0) return undefined;
    total += i + (w[i] === q ? 0 : 0.5);
  }
  return total;
}

function rank<T>(items: T[], text: (t: T) => string, query: string, tiebreak: (a: T, b: T) => number): T[] {
  const q = words(query);
  return items
    .map((item) => ({ item, s: score(text(item), q) }))
    .filter((x): x is { item: T; s: number } => x.s !== undefined)
    .sort((a, b) => a.s - b.s || tiebreak(a.item, b.item))
    .slice(0, MAX_CHOICES)
    .map((x) => x.item);
}

/** Task autocomplete: matches name and ID; tiers of one source stay together, lowest first. */
export function searchTasks(tasks: Task[], query: string): Choice[] {
  return rank(tasks, (t) => `${t.name} ${t.id}`, query, (a, b) =>
    (a.group ?? a.id).localeCompare(b.group ?? b.id) || (a.tier ?? 0) - (b.tier ?? 0))
    .map((t) => ({ name: clip(`${t.name} (+${t.xp} XP)`), value: t.id }));
}

/** Distinct activities in the catalogue, with a label naming one task that uses it. */
export function activities(catalogue: Catalogue): { id: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const t of catalogue.tasks) {
    if (t.activity && !seen.has(t.activity)) seen.set(t.activity, t.group ? sourceName(t.name) : t.name);
  }
  return [...seen].map(([id, label]) => ({ id, label }));
}

export function searchActivities(catalogue: Catalogue, query: string, include: (id: string) => boolean = () => true): Choice[] {
  return rank(activities(catalogue).filter((a) => include(a.id)), (a) => `${a.id} ${a.label}`, query, (a, b) => a.id.localeCompare(b.id))
    .map((a) => ({ name: clip(`${a.id} · ${a.label}`), value: a.id }));
}

/** One XP source: every tier of one group ("Wheat collection", "Revenant Horror Slayer"). */
export interface Source {
  id: string;
  label: string;
  category: string;
  tiers: number;
  xp: number;
}

const sourceCache = new WeakMap<Catalogue, Source[]>();

/**
 * Non-monetary sources in the catalogue. A label shared by two sources
 * ("Bat Bestiary" on the island and in the Catacombs) gets its location added.
 */
export function sources(catalogue: Catalogue): Source[] {
  const cached = sourceCache.get(catalogue);
  if (cached) return cached;
  const map = new Map<string, Source & { location?: string }>();
  for (const t of catalogue.tasks) {
    if (t.monetary) continue;
    const id = t.group ?? t.id;
    const s = map.get(id);
    if (s) {
      s.tiers++;
      s.xp += t.xp;
    } else map.set(id, { id, label: t.group ? sourceName(t.name) : t.name, category: t.category, tiers: 1, xp: t.xp, location: t.location });
  }
  const count = new Map<string, number>();
  for (const s of map.values()) count.set(s.label, (count.get(s.label) ?? 0) + 1);
  const list = [...map.values()].map(({ location, ...s }) => ({
    ...s,
    label: (count.get(s.label) ?? 0) > 1 && location ? `${s.label} · ${location}` : s.label,
  }));
  sourceCache.set(catalogue, list);
  return list;
}

/** Source of a task, as used by source exclusions. */
export const sourceId = (t: Task) => t.group ?? t.id;

export function searchSources(catalogue: Catalogue, query: string, include: (s: Source) => boolean = () => true): Choice[] {
  const names = new Map(catalogue.meta.categories.map((c) => [c.id, c.name]));
  return rank(sources(catalogue).filter(include), (s) => `${s.label} ${s.id}`, query, (a, b) => a.id.localeCompare(b.id))
    .map((s) => ({ name: clip(`${s.label} · ${names.get(s.category) ?? s.category} (${s.xp.toLocaleString('en-US')} XP)`), value: s.id }));
}

/** Resolves typed source input: an ID, an exact label, or a task in it. */
export function findSource(catalogue: Catalogue, input: string): Source | undefined {
  const s = input.trim().toLowerCase();
  const all = sources(catalogue);
  const task = findTask(catalogue, input);
  return all.find((x) => x.id.toLowerCase() === s) ?? all.find((x) => x.label.toLowerCase() === s) ?? (task ? all.find((x) => x.id === sourceId(task)) : undefined);
}

/** Resolves what the user typed when they didn't pick an autocomplete choice: an ID, or an exact name. */
export function findTask(catalogue: Catalogue, input: string): Task | undefined {
  const s = input.trim();
  return catalogue.byId.get(s) ?? catalogue.tasks.find((t) => t.name.toLowerCase() === s.toLowerCase());
}
