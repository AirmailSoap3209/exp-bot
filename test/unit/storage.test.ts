import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonStore } from '../../src/storage/jsonStore.js';
import { parseRateValue, profileKey, UserData } from '../../src/storage/userData.js';

const tempDir = () => mkdtemp(join(tmpdir(), 'xpbot-store-'));

describe('JsonStore', () => {
  it('starts from defaults, persists, and is read back by a new instance', async () => {
    const file = join(await tempDir(), 'x.json');
    const a = new JsonStore<{ n: number }>(file, () => ({ n: 0 }));
    expect(await a.read()).toEqual({ n: 0 });
    await a.update((d) => void (d.n = 5));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ n: 5 });
    expect(await new JsonStore(file, () => ({ n: 0 })).read()).toEqual({ n: 5 });
  });

  it('serialises concurrent updates and leaves no temp files', async () => {
    const dir = await tempDir();
    const s = new JsonStore<{ list: number[] }>(join(dir, 'x.json'), () => ({ list: [] }));
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.update((d) => void d.list.push(i))));
    expect((await s.read()).list).toHaveLength(20);
    expect(await readdir(dir)).toEqual(['x.json']);
  });

  it('refuses to silently replace a corrupt file', async () => {
    const file = join(await tempDir(), 'x.json');
    await writeFile(file, '{ not json');
    await expect(new JsonStore(file, () => ({})).read()).rejects.toThrow(/Could not read .*Fix or remove the file/);
  });
});

describe('UserData', () => {
  it('stores links, exclusions, ticks and rate overrides', async () => {
    const u = new UserData(await tempDir());
    expect(await u.getLink('d1')).toBeUndefined();
    await u.setLink('d1', { uuid: 'u', name: 'Steve', profileId: 'p-1', profileName: 'Lime' });
    expect(await u.getLink('d1')).toMatchObject({ uuid: 'u', profileName: 'Lime' });

    expect(await u.setExcluded('d1', 'bestiary', true)).toEqual(['bestiary']);
    expect(await u.setExcluded('d1', 'minions', true)).toEqual(['bestiary', 'minions']);
    expect([...(await u.getExcluded('d1'))]).toEqual(['bestiary', 'minions']);
    expect(await u.setExcluded('d1', 'bestiary', false)).toEqual(['minions']);
    expect((await u.getExcluded('other')).size).toBe(0);

    const key = profileKey('u', 'p-1');
    expect(key).toBe('u:p1');
    expect(await u.addTick(key, 'a')).toBe(true);
    expect(await u.addTick(key, 'a')).toBe(false);
    await u.addTick(key, 'b');
    expect(await u.removeTicks(key, ['a', 'zzz'])).toEqual(['a']);
    expect([...(await u.getTicks(key))]).toEqual(['b']);
    expect((await u.getTicks(profileKey('u', 'other'))).size).toBe(0); // ticks are per profile

    expect(await u.setRateOverride(key, 'combat.hub.zombie', { bracket: 'late', setAt: 'x' })).toBe(true);
    expect(await u.getRateOverrides(key)).toEqual({ 'combat.hub.zombie': { bracket: 'late', setAt: 'x' } });
    expect(await u.setRateOverride(key, 'combat.hub.zombie', undefined)).toBe(true);
    expect(await u.setRateOverride(key, 'combat.hub.zombie', undefined)).toBe(false);
    expect(await u.getRateOverrides(key)).toEqual({});
  });
});

describe('default exclusions', () => {
  it('applies defaults until included, and remembers the include', async () => {
    const u = new UserData(await tempDir());
    const defaults = ['minions'];
    expect([...(await u.getExcluded('d1', defaults))]).toEqual(['minions']);
    expect(await u.setExcluded('d1', 'minions', false, defaults)).toEqual([]);
    expect([...(await u.getExcluded('d1', defaults))]).toEqual([]);
    expect(await u.setExcluded('d1', 'bestiary', true, defaults)).toEqual(['bestiary']);
    expect(await u.setExcluded('d1', 'minions', true, defaults)).toEqual(['bestiary', 'minions']);
    expect([...(await u.getExcluded('d1', defaults))].sort()).toEqual(['bestiary', 'minions']);
    // Another user still gets the default.
    expect([...(await u.getExcluded('d2', defaults))]).toEqual(['minions']);
  });
});

describe('parseRateValue', () => {
  it.each([
    ['late', { bracket: 'late' }],
    ['  MID ', { bracket: 'mid' }],
    ['12.5', { rate: 12.5 }],
  ])('parses %j', (raw, expected) => {
    const r = parseRateValue(raw);
    expect(r.ok && r.override).toMatchObject(expected);
  });
  it('clears with default', () => expect(parseRateValue('default')).toEqual({ ok: true, override: undefined }));
  it.each(['0', '-3', 'fast', ''])('rejects %j', (raw) => expect(parseRateValue(raw).ok).toBe(false));
});
