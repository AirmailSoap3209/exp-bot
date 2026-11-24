import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRates } from '../../src/estimate/rates.js';
import type { ProfilesResponse } from '../../src/hypixel/client.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import type { NormalizedProfile } from '../../src/profile/types.js';
import {
  activityMetric, blend, BLEND_WEIGHT, changes, measurableActivities, measure, takeSnapshot,
} from '../../src/sessions/sessions.js';
import { UserData, type OpenSession } from '../../src/storage/userData.js';
import { loadCatalogue } from '../../src/tasks/catalogue.js';

const catalogue = loadCatalogue();
const book = loadRates();
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
const skills = read<SkillsResource>('../fixtures/resource-skills.json');
function profile(player: string, name: string): NormalizedProfile {
  const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>(`../fixtures/profiles-${player}.json`);
  return normalizeProfile(pickProfile(response.profiles, name)!, uuid, skills, 0);
}
const lime = profile('floor7sweat', 'lime');

describe('measurable activities', () => {
  it('each maps to exactly one metric, and Lime shows a value for it', () => {
    const ok = measurableActivities(catalogue, book);
    expect(ok.size).toBeGreaterThan(400);
    const snap = takeSnapshot(catalogue, book, lime);
    for (const a of ok) {
      const metrics = new Set(catalogue.tasks.filter((t) => t.activity === a).map((t) => t.requires.metric));
      expect(metrics.size, a).toBe(1);
      expect(snap[activityMetric(catalogue, a)!.metric], a).toBeTypeOf('number');
    }
    // Fixed-time activities (minion crafts) can't be measured.
    expect(ok.has('minion.wheat')).toBe(false);
  });
});

describe('takeSnapshot', () => {
  it('records real values, not "complete" stand-ins', () => {
    const s = takeSnapshot(catalogue, book, lime);
    expect(s['slayer.zombie.xp']).toBe(104305);
    expect(s['collections.WHEAT']).toBe(3364753);
    expect(s['bestiary.milestone']).toBe(154);
    expect(s['catacombs.completions.7']).toBe(53);
  });

  it("uses the player's own collection, not the co-op total", () => {
    const s = takeSnapshot(catalogue, book, profile('ducksterr_', 'raspberry'));
    expect(s['collections.WHEAT']).toBe(2876756);
  });

  it('leaves out metrics the profile hides', () => {
    const s = takeSnapshot(catalogue, book, profile('floor7sweat', 'pineapple'));
    expect(Object.keys(s).some((m) => m.startsWith('collections.'))).toBe(false);
    expect(s['slayer.zombie.xp']).toBeUndefined();
    expect(s['skills.farming.xp']).toBe(483000);
  });
});

describe('measure', () => {
  const a = { x: 100 };
  it('divides the change by the minutes', () => expect(measure('x', a, { x: 400 }, 20)).toEqual({ ok: true, delta: 300, minutes: 20, rate: 15 }));
  it('rejects sessions under 15 minutes', () => expect(measure('x', a, { x: 400 }, 14.9)).toMatchObject({ ok: false, reason: 'too_short' }));
  it('rejects sessions over 4 hours', () => expect(measure('x', a, { x: 400 }, 241)).toMatchObject({ ok: false, reason: 'expired' }));
  it('rejects no progress', () => expect(measure('x', a, { x: 100 }, 30)).toMatchObject({ ok: false, reason: 'no_progress' }));
  it('rejects a metric missing at either end', () => expect(measure('x', a, {}, 30)).toMatchObject({ ok: false, reason: 'no_data' }));
});

describe('blend', () => {
  it('starts at the first rate, then favours the newest', () => {
    const one = blend(undefined, 100, 20, 't1');
    expect(one).toMatchObject({ rate: 100, sessions: 1 });
    const two = blend(one, 200, 30, 't2');
    expect(two.rate).toBeCloseTo(BLEND_WEIGHT * 200 + (1 - BLEND_WEIGHT) * 100);
    expect(two.history.map((h) => h.endedAt)).toEqual(['t2', 't1']);
    let r = two;
    for (let n = 0; n < 30; n++) r = blend(r, 150, 20, `x${n}`);
    expect(r.history).toHaveLength(20);
    expect(r.sessions).toBe(32);
  });
});

describe('a simulated Revenant session on Lime', () => {
  it('measures slayer XP per minute and reports what else moved', () => {
    const start = takeSnapshot(catalogue, book, lime);
    const after = structuredClone(lime);
    if (after.slayer.available) after.slayer.value.zombie.xp += 3000;
    if (after.collections.amounts.available) after.collections.amounts.value.ownByItem.ROTTEN_FLESH = (after.collections.amounts.value.ownByItem.ROTTEN_FLESH ?? 0) + 800;
    const end = takeSnapshot(catalogue, book, after);
    expect(measure(activityMetric(catalogue, 'slayer.zombie')!.metric, start, end, 20)).toMatchObject({ ok: true, delta: 3000, rate: 150 });
    expect(changes(start, end)).toEqual([
      { metric: 'slayer.zombie.xp', delta: 3000 },
      { metric: 'collections.ROTTEN_FLESH', delta: 800 },
    ]);
  });
});

describe('session storage', () => {
  it('holds one open session per user and keeps rates per profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xpbot-sess-'));
    const u = new UserData(dir);
    const s: OpenSession = {
      activity: 'slayer.zombie', metric: 'slayer.zombie.xp', category: 'slayer', uuid: 'u', profileId: 'p',
      playerName: 'Steve', profileName: 'Lime', startedAt: 0, snapshot: { 'slayer.zombie.xp': 1 },
    };
    expect(await u.startSession('d1', s)).toBe(true);
    expect(await u.startSession('d1', s)).toBe(false);
    expect((await u.getOpenSession('d1'))?.activity).toBe('slayer.zombie');
    expect((await u.closeSession('d1'))?.activity).toBe('slayer.zombie');
    expect(await u.getOpenSession('d1')).toBeUndefined();

    await u.setSessionRate('u:p', 'slayer.zombie', blend(undefined, 150, 20, 't'));
    expect(await u.getSessionRateNumbers('u:p')).toEqual({ 'slayer.zombie': 150 });
    expect(await u.getSessionRateNumbers('u:other')).toEqual({});
    expect(JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'))).toMatchObject({ open: {}, rates: { 'u:p': { 'slayer.zombie': { rate: 150 } } } });
  });
});
