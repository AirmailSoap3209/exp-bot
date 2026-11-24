import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HypixelApiError, HypixelClient, PlayerNotFoundError } from '../../src/hypixel/client.js';

const UUID = '0123456789abcdef0123456789abcdef';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

async function makeClient(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const dir = await mkdtemp(join(tmpdir(), 'xpbot-'));
  const logPath = join(dir, 'requests.log');
  let t = 1_000_000;
  const sleeps: number[] = [];
  const client = new HypixelClient({
    apiKey: 'secret-key',
    lowWater: 2,
    profileTtlMs: 60_000,
    resourceTtlMs: 86_400_000,
    requestLogPath: logPath,
    fetch: vi.fn(fetchImpl) as unknown as typeof fetch,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { client, logPath, sleeps, advance: (ms: number) => (t += ms) };
}

describe('HypixelClient', () => {
  it('sends the key, caches profiles for 60s, and logs keyed requests without the key', async () => {
    const calls: { url: string; key?: string }[] = [];
    const { client, logPath, advance } = await makeClient(async (url, init) => {
      calls.push({ url, key: (init?.headers as Record<string, string> | undefined)?.['API-Key'] });
      return json({ success: true, profiles: [] }, 200, { 'ratelimit-limit': '300', 'ratelimit-remaining': '299', 'ratelimit-reset': '200' });
    });

    const first = await client.getProfiles(UUID);
    const second = await client.getProfiles(UUID);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ key: 'secret-key' });
    expect(calls[0]!.url).toContain(`/v2/skyblock/profiles?uuid=${UUID}`);

    advance(60_000);
    await client.getProfiles(UUID);
    expect(calls).toHaveLength(2);

    const log = (await readFile(logPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ status: 200, remaining: 299, limit: 300 });
    expect(JSON.stringify(log)).not.toContain('secret-key');
  });

  it('backs off when remaining is low instead of failing', async () => {
    let remaining = 3;
    const { client, sleeps } = await makeClient(async () =>
      json({ success: true, profiles: [] }, 200, { 'ratelimit-remaining': String(remaining--), 'ratelimit-reset': '30' }),
    );
    await client.getProfiles(UUID, { skipCache: true }); // remaining=3
    await client.getProfiles(UUID, { skipCache: true }); // remaining=2 -> at low water
    expect(sleeps).toEqual([]);
    await client.getProfiles(UUID, { skipCache: true }); // must wait for reset first
    expect(sleeps).toEqual([30_000]);
  });

  it('retries a 429 after the reset window', async () => {
    let n = 0;
    const { client, sleeps } = await makeClient(async () =>
      n++ === 0
        ? json({ success: false, cause: 'Key throttle' }, 429, { 'ratelimit-remaining': '0', 'ratelimit-reset': '12' })
        : json({ success: true, profiles: [] }, 200, { 'ratelimit-remaining': '100' }),
    );
    const r = await client.getProfiles(UUID);
    expect(r.data.success).toBe(true);
    expect(sleeps).toEqual([12_000]);
  });

  it('surfaces API errors with the cause', async () => {
    const { client } = await makeClient(async () => json({ success: false, cause: 'Invalid API key' }, 403));
    await expect(client.getProfiles(UUID)).rejects.toBeInstanceOf(HypixelApiError);
    await expect(client.getProfiles(UUID)).rejects.toThrow(/403.*Invalid API key/);
  });

  it('resolves usernames through Mojang and caches them; passes UUIDs through', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('Nobody') ? new Response(null, { status: 404 }) : json({ id: UUID, name: 'Steve' }),
    );
    const { client } = await makeClient(fetchImpl);
    expect(await client.resolvePlayer('steve')).toEqual({ uuid: UUID, name: 'Steve' });
    await client.resolvePlayer('STEVE');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await client.resolvePlayer('01234567-89ab-cdef-0123-456789abcdef')).uuid).toBe(UUID);
    await expect(client.resolvePlayer('Nobody')).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});
