interface Entry<V> {
  value: V;
  storedAt: number;
  expiresAt: number;
}

/**
 * In-memory TTL cache. Concurrent loads for the same key share one promise,
 * so two commands arriving together cost one API call.
 */
export class TtlCache<V> {
  private entries = new Map<string, Entry<V>>();
  private inflight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): { value: V; storedAt: number } | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() >= e.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: e.value, storedAt: e.storedAt };
  }

  set(key: string, value: V): void {
    const t = this.now();
    this.entries.set(key, { value, storedAt: t, expiresAt: t + this.ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Returns the cached value, or runs `load` once and caches its result. Failures are not cached. */
  async getOrLoad(
    key: string,
    load: () => Promise<V>,
    opts: { skipCache?: boolean } = {},
  ): Promise<{ value: V; storedAt: number; fromCache: boolean }> {
    if (!opts.skipCache) {
      const hit = this.get(key);
      if (hit) return { ...hit, fromCache: true };
      const pending = this.inflight.get(key);
      if (pending) {
        const value = await pending;
        return { value, storedAt: this.entries.get(key)?.storedAt ?? this.now(), fromCache: true };
      }
    }
    const p = load();
    this.inflight.set(key, p);
    try {
      const value = await p;
      this.set(key, value);
      return { value, storedAt: this.now(), fromCache: false };
    } finally {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    }
  }
}
