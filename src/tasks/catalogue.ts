import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORY_STATUS, TRACKING, type Meta, type Task } from './types.js';

export const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

export class CatalogueError extends Error {
  constructor(readonly problems: string[]) {
    super(`Task catalogue is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  ${problems.slice(0, 25).join('\n  ')}${problems.length > 25 ? `\n  …and ${problems.length - 25} more` : ''}`);
    this.name = 'CatalogueError';
  }
}

export interface Catalogue {
  meta: Meta;
  tasks: Task[];
  byId: Map<string, Task>;
  byCategory: Map<string, Task[]>;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isPosNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Checks one raw entry's shape. Returns problems, prefixed with `where`. */
export function validateTask(raw: unknown, where: string): string[] {
  const p: string[] = [];
  if (typeof raw !== 'object' || raw === null) return [`${where}: not an object`];
  const t = raw as Record<string, unknown>;
  const at = `${where} ${isStr(t.id) ? t.id : '(no id)'}`;
  for (const k of ['id', 'category', 'name', 'description', 'source'] as const) {
    if (!isStr(t[k])) p.push(`${at}: ${k} must be a non-empty string`);
  }
  if (!Number.isInteger(t.xp) || (t.xp as number) <= 0) p.push(`${at}: xp must be a positive integer`);
  const req = t.requires as Record<string, unknown> | undefined;
  if (typeof req !== 'object' || req === null || !isStr(req.metric) || !isPosNum(req.amount)) {
    p.push(`${at}: requires must be { metric: string, amount: number > 0 }`);
  }
  if (!Array.isArray(t.prerequisites) || !t.prerequisites.every(isStr)) p.push(`${at}: prerequisites must be a string array`);
  if (t.activity !== null && !isStr(t.activity)) p.push(`${at}: activity must be a string or null`);
  if (typeof t.monetary !== 'boolean') p.push(`${at}: monetary must be true or false`);
  if (!TRACKING.includes(t.tracking as never)) p.push(`${at}: tracking must be one of ${TRACKING.join(', ')}`);
  for (const k of ['location', 'group', 'hypixelTaskId'] as const) {
    if (t[k] !== undefined && !isStr(t[k])) p.push(`${at}: ${k} must be a non-empty string when present`);
  }
  if (t.tier !== undefined && !(Number.isInteger(t.tier) && (t.tier as number) > 0)) p.push(`${at}: tier must be a positive integer`);
  if (t.minutes !== undefined) {
    const m = t.minutes;
    if (!Array.isArray(m) || m.length !== 2 || !m.every((x) => typeof x === 'number' && x > 0) || m[0] > m[1]) {
      p.push(`${at}: minutes must be [low, high] with 0 < low <= high`);
    }
  }
  if (t.activity === null && t.minutes === undefined) p.push(`${at}: a task with no activity needs fixed minutes`);
  return p;
}

function validateMeta(meta: Meta): string[] {
  const p: string[] = [];
  const guides = new Set(meta.guideCategories.map((g) => g.id));
  const seen = new Set<string>();
  for (const c of meta.categories) {
    if (seen.has(c.id)) p.push(`meta.json: duplicate category ${c.id}`);
    seen.add(c.id);
    if (!CATEGORY_STATUS.includes(c.status)) p.push(`meta.json: category ${c.id} has bad status ${c.status}`);
    if (!guides.has(c.guide)) p.push(`meta.json: category ${c.id} points at unknown guide category ${c.guide}`);
  }
  return p;
}

/** Validates a whole catalogue: entry shapes, then cross-entry rules. Throws CatalogueError. */
export function buildCatalogue(meta: Meta, files: { file: string; entries: unknown }[]): Catalogue {
  const problems = validateMeta(meta);
  const categories = new Map(meta.categories.map((c) => [c.id, c]));
  const tasks: Task[] = [];

  for (const { file, entries } of files) {
    const category = basename(file, '.json');
    if (!categories.has(category)) problems.push(`${file}: no category "${category}" in meta.json`);
    if (!Array.isArray(entries)) {
      problems.push(`${file}: must be a JSON array of tasks`);
      continue;
    }
    entries.forEach((raw, i) => {
      const shape = validateTask(raw, `${file}[${i}]`);
      problems.push(...shape);
      if (shape.length) return;
      const t = raw as Task;
      if (t.category !== category) problems.push(`${file}[${i}] ${t.id}: category "${t.category}" does not match file`);
      if (categories.get(category)?.status === 'never' && !t.monetary) {
        problems.push(`${file}[${i}] ${t.id}: category is excluded as monetary, so the task must be monetary: true`);
      }
      tasks.push(t);
    });
  }

  const byId = new Map<string, Task>();
  for (const t of tasks) {
    if (byId.has(t.id)) problems.push(`duplicate task id ${t.id}`);
    byId.set(t.id, t);
  }
  for (const t of tasks) {
    for (const pre of t.prerequisites) if (!byId.has(pre)) problems.push(`${t.id}: unknown prerequisite ${pre}`);
  }
  problems.push(...findCycles(tasks, byId));

  if (problems.length) throw new CatalogueError(problems);

  const byCategory = new Map<string, Task[]>();
  for (const t of tasks) byCategory.set(t.category, [...(byCategory.get(t.category) ?? []), t]);
  return { meta, tasks, byId, byCategory };
}

function findCycles(tasks: Task[], byId: Map<string, Task>): string[] {
  const state = new Map<string, 'visiting' | 'done'>();
  const problems: string[] = [];
  const visit = (id: string, path: string[]) => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') {
      problems.push(`prerequisite cycle: ${[...path.slice(path.indexOf(id)), id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const pre of byId.get(id)?.prerequisites ?? []) if (byId.has(pre)) visit(pre, [...path, id]);
    state.set(id, 'done');
  };
  for (const t of tasks) visit(t.id, []);
  return problems;
}

/** Loads data/meta.json and every data/tasks/*.json, validating all of it. */
export function loadCatalogue(dataDir = DATA_DIR): Catalogue {
  const meta = JSON.parse(readFileSync(join(dataDir, 'meta.json'), 'utf8')) as Meta;
  const tasksDir = join(dataDir, 'tasks');
  const files = readdirSync(tasksDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return { file: `tasks/${f}`, entries: JSON.parse(readFileSync(join(tasksDir, f), 'utf8')) as unknown };
      } catch (err) {
        throw new CatalogueError([`tasks/${f}: invalid JSON (${(err as Error).message})`]);
      }
    });
  return buildCatalogue(meta, files);
}
