import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './jsonStore.js';

export const STORAGE_DIR = fileURLToPath(new URL('../../storage-data/', import.meta.url));

export interface Link {
  uuid: string;
  name: string;
  profileId: string;
  profileName: string;
  linkedAt: string;
}

/** A rate override: a named bracket, or a number in the activity's own unit. */
export type RateOverride = { bracket: string; setAt: string } | { rate: number; setAt: string };

export const BRACKETS = ['early', 'mid', 'late'] as const;

export interface UserSettings {
  excludedCategories: string[];
  /** Categories excluded by default (meta.json) that the user brought back with /xp include. */
  includedCategories?: string[];
}

/** Ticks and rate overrides belong to one profile of one player. */
export const profileKey = (uuid: string, profileId: string) => `${uuid}:${profileId.replace(/-/g, '')}`;

export interface OpenSession {
  activity: string;
  metric: string;
  category: string;
  uuid: string;
  profileId: string;
  playerName: string;
  profileName: string;
  startedAt: number;
  snapshot: Record<string, number>;
}

/** Blended measured rate for one activity (see src/sessions). */
export interface StoredSessionRate {
  rate: number;
  sessions: number;
  history: { rate: number; minutes: number; endedAt: string }[];
}

interface Stores {
  links: JsonStore<Record<string, Link>>;
  settings: JsonStore<Record<string, UserSettings>>;
  ticks: JsonStore<Record<string, string[]>>;
  rates: JsonStore<Record<string, Record<string, RateOverride>>>;
  sessions: JsonStore<{ open: Record<string, OpenSession>; rates: Record<string, Record<string, StoredSessionRate>> }>;
}

/** Everything the bot remembers, keyed by Discord user ID or profile key. */
export class UserData {
  private readonly s: Stores;

  constructor(dir = STORAGE_DIR) {
    this.s = {
      links: new JsonStore(join(dir, 'links.json'), () => ({})),
      settings: new JsonStore(join(dir, 'settings.json'), () => ({})),
      ticks: new JsonStore(join(dir, 'ticks.json'), () => ({})),
      rates: new JsonStore(join(dir, 'rate-overrides.json'), () => ({})),
      sessions: new JsonStore(join(dir, 'sessions.json'), () => ({ open: {}, rates: {} })),
    };
  }

  /** Waits for pending writes in every store (used on shutdown). */
  async flush(): Promise<void> {
    await Promise.all(Object.values(this.s).map((store) => store.flush()));
  }

  // ---- sessions ----
  async getOpenSession(discordId: string): Promise<OpenSession | undefined> {
    return (await this.s.sessions.read()).open[discordId];
  }

  /** Returns false if one is already open. */
  startSession(discordId: string, session: OpenSession): Promise<boolean> {
    return this.s.sessions.update((d) => {
      if (d.open[discordId]) return false;
      d.open[discordId] = session;
      return true;
    });
  }

  /** Closes the open session; returns it, or undefined if there was none. */
  closeSession(discordId: string): Promise<OpenSession | undefined> {
    return this.s.sessions.update((d) => {
      const s = d.open[discordId];
      delete d.open[discordId];
      return s;
    });
  }

  async getSessionRates(key: string): Promise<Record<string, StoredSessionRate>> {
    return { ...((await this.s.sessions.read()).rates[key] ?? {}) };
  }

  /** Measured rates as plain numbers, for the estimator. */
  async getSessionRateNumbers(key: string): Promise<Record<string, number>> {
    return Object.fromEntries(Object.entries(await this.getSessionRates(key)).map(([a, r]) => [a, r.rate]));
  }

  setSessionRate(key: string, activity: string, rate: StoredSessionRate): Promise<void> {
    return this.s.sessions.update((d) => {
      (d.rates[key] ??= {})[activity] = rate;
    });
  }

  // ---- links ----
  async getLink(discordId: string): Promise<Link | undefined> {
    return (await this.s.links.read())[discordId];
  }

  setLink(discordId: string, link: Omit<Link, 'linkedAt'>): Promise<Link> {
    return this.s.links.update((d) => (d[discordId] = { ...link, linkedAt: new Date().toISOString() }));
  }

  // ---- category filter ----
  /** Effective exclusions: the defaults the user hasn't included, plus the user's own exclusions. */
  async getExcluded(discordId: string, defaults: readonly string[] = []): Promise<Set<string>> {
    const s = (await this.s.settings.read())[discordId];
    const included = new Set(s?.includedCategories ?? []);
    return new Set([...defaults.filter((c) => !included.has(c)), ...(s?.excludedCategories ?? [])]);
  }

  /** Excludes or includes one category; returns the new effective exclusion list. */
  setExcluded(discordId: string, category: string, excluded: boolean, defaults: readonly string[] = []): Promise<string[]> {
    return this.s.settings.update((d) => {
      const ex = new Set(d[discordId]?.excludedCategories ?? []);
      const inc = new Set(d[discordId]?.includedCategories ?? []);
      if (excluded) {
        ex.add(category);
        inc.delete(category);
      } else {
        ex.delete(category);
        if (defaults.includes(category)) inc.add(category);
      }
      d[discordId] = { excludedCategories: [...ex].sort(), ...(inc.size ? { includedCategories: [...inc].sort() } : {}) };
      return [...new Set([...defaults.filter((c) => !inc.has(c)), ...ex])].sort();
    });
  }

  // ---- ticks ----
  async getTicks(key: string): Promise<Set<string>> {
    return new Set((await this.s.ticks.read())[key] ?? []);
  }

  /** Returns false if the task was already ticked. */
  addTick(key: string, taskId: string): Promise<boolean> {
    return this.s.ticks.update((d) => {
      const list = d[key] ?? [];
      if (list.includes(taskId)) return false;
      d[key] = [...list, taskId].sort();
      return true;
    });
  }

  /** Removes ticks; returns the IDs that were actually removed. */
  removeTicks(key: string, taskIds: string[]): Promise<string[]> {
    return this.s.ticks.update((d) => {
      const list = d[key] ?? [];
      const removed = list.filter((t) => taskIds.includes(t));
      if (removed.length) d[key] = list.filter((t) => !taskIds.includes(t));
      if (d[key]?.length === 0) delete d[key];
      return removed;
    });
  }

  // ---- rate overrides ----
  async getRateOverrides(key: string): Promise<Record<string, RateOverride>> {
    return { ...((await this.s.rates.read())[key] ?? {}) };
  }

  /** `override` undefined clears it. Returns whether anything changed. */
  setRateOverride(key: string, activity: string, override: RateOverride | undefined): Promise<boolean> {
    return this.s.rates.update((d) => {
      const map = d[key] ?? {};
      if (!override) {
        if (!(activity in map)) return false;
        delete map[activity];
      } else map[activity] = override;
      if (Object.keys(map).length) d[key] = map;
      else delete d[key];
      return true;
    });
  }
}

/** Parses the /xp rate value: a bracket name, a positive number, or "default" to clear. */
export function parseRateValue(raw: string): { ok: true; override: RateOverride | undefined } | { ok: false; error: string } {
  const v = raw.trim().toLowerCase();
  const setAt = new Date().toISOString();
  if (v === 'default' || v === 'reset' || v === 'clear') return { ok: true, override: undefined };
  if ((BRACKETS as readonly string[]).includes(v)) return { ok: true, override: { bracket: v, setAt } };
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return { ok: true, override: { rate: n, setAt } };
  return { ok: false, error: `"${raw}" isn't a bracket (${BRACKETS.join(', ')}), a positive number, or "default".` };
}

export const userData = new UserData();
