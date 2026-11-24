import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../../src/hypixel/cache.js';

describe('TtlCache', () => {
  it('serves cached values inside the TTL and reloads after it', async () => {
    let t = 0;
    const cache = new TtlCache<number>(60_000, () => t);
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect((await cache.getOrLoad('u', load)).fromCache).toBe(false);
    t = 59_999;
    const hit = await cache.getOrLoad('u', load);
    expect(hit).toMatchObject({ value: 1, fromCache: true, storedAt: 0 });
    t = 60_000;
    expect((await cache.getOrLoad('u', load)).value).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one load between concurrent callers', async () => {
    const cache = new TtlCache<number>(1000);
    const load = vi.fn(() => new Promise<number>((r) => setTimeout(() => r(7), 5)));
    const [a, b] = await Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load)]);
    expect(a.value).toBe(7);
    expect(b.value).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('skipCache forces a reload', async () => {
    const cache = new TtlCache<number>(60_000);
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    await cache.getOrLoad('k', load);
    expect((await cache.getOrLoad('k', load, { skipCache: true })).value).toBe(2);
  });

  it('does not cache failures', async () => {
    const cache = new TtlCache<number>(60_000);
    await expect(cache.getOrLoad('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect((await cache.getOrLoad('k', async () => 3)).value).toBe(3);
  });
});
