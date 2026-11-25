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

describe('RequestLog rotation', () => {
  it('moves a full log to .1 and starts a new one', async () => {
    const { RequestLog } = await import('../../src/hypixel/requestLog.js');
    const dir = await tempDir();
    const file = join(dir, 'req.log');
    const entry = { time: 't', path: '/x', status: 200, durationMs: 1, attempt: 1 };
    await writeFile(file, 'x'.repeat(200));
    const log = new RequestLog(file, 100);
    await log.write(entry); // first write checks the size: 200 >= 100, so rotate
    expect((await readFile(`${file}.1`, 'utf8')).length).toBe(200);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ path: '/x' });
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

describe('source exclusions', () => {
  it('stores sources per user, reports changes, and survives category changes', async () => {
    const u = new UserData(await tempDir());
    expect((await u.getExcludedSources('d1')).size).toBe(0);
    expect(await u.setSourceExcluded('d1', 'collections.wheat', true)).toEqual({ changed: true, list: ['collections.wheat'] });
    expect(await u.setSourceExcluded('d1', 'collections.wheat', true)).toEqual({ changed: false, list: ['collections.wheat'] });
    await u.setSourceExcluded('d1', 'skills.alchemy', true);
    // Category changes keep source exclusions, and source changes keep category ones.
    await u.setExcluded('d1', 'bestiary', true, ['minions']);
    await u.setExcluded('d1', 'minions', false, ['minions']);
    expect([...(await u.getExcludedSources('d1'))]).toEqual(['collections.wheat', 'skills.alchemy']);
    expect(await u.setSourceExcluded('d1', 'collections.wheat', false)).toEqual({ changed: true, list: ['skills.alchemy'] });
    expect([...(await u.getExcluded('d1', ['minions']))]).toEqual(['bestiary']);
    expect(await u.setSourceExcluded('d1', 'nope', false)).toEqual({ changed: false, list: ['skills.alchemy'] });
    expect((await u.getExcludedSources('d2')).size).toBe(0);
  });
});
