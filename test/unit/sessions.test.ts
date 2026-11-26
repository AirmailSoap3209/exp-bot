import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRates } from '../../src/estimate/rates.js';
import type { GardenResponse, ProfilesResponse } from '../../src/hypixel/client.js';
import { withLearnedLinks } from '../../src/combos/learned.js';
import { loadCombos } from '../../src/combos/combos.js';
import { metricLabel } from '../../src/optimizer/category.js';
import { findMetric } from '../../src/tasks/search.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import type { NormalizedProfile } from '../../src/profile/types.js';
import {
  activityMetric, blend, BLEND_WEIGHT, changes, LINK_MAX_SPREAD, LINK_MIN_SESSIONS, linkStatus, measurableActivities, measure, measureLinks, measureRatios, takeSnapshot,
} from '../../src/sessions/sessions.js';
import { UserData, type OpenSession } from '../../src/storage/userData.js';
import { loadCatalogue } from '../../src/tasks/catalogue.js';

const catalogue = loadCatalogue();
const book = loadRates();
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
const skills = read<SkillsResource>('../fixtures/resource-skills.json');
function profile(player: string, name: string): NormalizedProfile {
  const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>(`../fixtures/profiles-${player}.json`);
  const garden = name === 'lime' ? read<{ response: GardenResponse }>('../fixtures/garden-Floor7Sweat-lime.json').response : undefined;
  return normalizeProfile(pickProfile(response.profiles, name)!, uuid, skills, 0, garden);
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

describe('combo ratios from sessions', () => {
  const combos = [
    { id: 'combo.slayer.zombie', primary: 'slayer.zombie', yields: [{ metric: 'skills.combat.xp' }, { metric: 'collections.ROTTEN_FLESH' }] },
    { id: 'combo.other', primary: 'collect.wheat', yields: [{ metric: 'skills.farming.xp' }] },
  ];
  const start = { 'slayer.zombie.xp': 1000, 'skills.combat.xp': 50_000, 'collections.ROTTEN_FLESH': 10, 'skills.farming.xp': 5 };

  it("measures each yield's change per primary unit, only for combos on the session's activity", () => {
    const end = { ...start, 'slayer.zombie.xp': 1500, 'skills.combat.xp': 56_000, 'skills.farming.xp': 900 };
    expect(measureRatios(combos, 'slayer.zombie', start, end, 500)).toEqual([
      { combo: 'combo.slayer.zombie', metric: 'skills.combat.xp', ratio: 12, delta: 6000 },
    ]); // rotten flesh didn't move, so it isn't measured; the wheat combo isn't this activity
  });

  it('skips yields missing from a snapshot, and sessions with no primary progress', () => {
    const { 'skills.combat.xp': _, ...noCombat } = start;
    expect(measureRatios(combos, 'slayer.zombie', noCombat, { ...start, 'skills.combat.xp': 60_000 }, 500)).toEqual([]);
    expect(measureRatios(combos, 'slayer.zombie', start, { ...start, 'skills.combat.xp': 60_000 }, 0)).toEqual([]);
  });

  it('stores and blends ratios per profile and combo', async () => {




    const u = new UserData(await mkdtemp(join(tmpdir(), 'xpbot-ratio-')));
    expect(await u.getComboRatios('k')).toEqual({});
    const first = blend(undefined, 12, 30, 't1');
    await u.setComboRatio('k', 'combo.slayer.zombie', 'skills.combat.xp', first);
    await u.setComboRatio('k', 'combo.slayer.zombie', 'skills.combat.xp', blend(first, 8, 30, 't2'));
    expect(await u.getComboRatioNumbers('k')).toEqual({ 'combo.slayer.zombie': { 'skills.combat.xp': 0.6 * 8 + 0.4 * 12 } });
    expect(await u.getComboRatioNumbers('other')).toEqual({});
  });
});

describe('linked metrics from sessions', () => {
  const book = loadRates();
  const catalogue = loadCatalogue();
  const start = { 'collections.MITHRIL_ORE': 1000, 'skills.mining.xp': 50_000, 'hotm.xp': 10, 'skills.combat.xp': 7 };
  const end = { ...start, 'collections.MITHRIL_ORE': 3000, 'skills.mining.xp': 140_000, 'hotm.xp': 410 };

  it('links everything else that went up, per unit of the activity', () => {
    expect(measureLinks('collections.MITHRIL_ORE', start, end, 2000)).toEqual([
      { metric: 'skills.mining.xp', ratio: 45, delta: 90_000 },
      { metric: 'hotm.xp', ratio: 0.2, delta: 400 },
    ]);
    expect(measureLinks('collections.MITHRIL_ORE', start, end, 0)).toEqual([]);
  });

  it('snapshots metrics no rated activity measures, like HOTM XP and Garden XP', () => {
    const snap = takeSnapshot(catalogue, book, lime);
    expect(snap['hotm.xp']).toBeCloseTo(147660.91, 1);
    expect(snap['garden.xp']).toBe(40878);
  });

  it(`adds a link to the activity's combo after ${LINK_MIN_SESSIONS} sessions, or makes a combo for an activity with none`, () => {
    const combos = loadCombos(catalogue, book);
    const once = { 'collect.mithril_ore': { 'hotm.xp': { rate: 0.2, sessions: 1 } } };
    expect(withLearnedLinks(combos, once, catalogue, book, (a) => a).find((c) => c.id === 'combo.mine.mithril_ore')!.yields.map((y) => y.metric)).toEqual(['skills.mining.xp']);
    const twice = { 'collect.mithril_ore': { 'hotm.xp': { rate: 0.2, sessions: 2 }, 'skills.mining.xp': { rate: 40, sessions: 3 } } };
    const mined = withLearnedLinks(combos, twice, catalogue, book, (a) => a).find((c) => c.id === 'combo.mine.mithril_ore')!;
    // The data yield stays as it is (its own measured ratio lives in the combo ratios); HOTM XP is added.
    expect(mined.yields.map((y) => [y.metric, y.learned ?? false])).toEqual([['skills.mining.xp', false], ['hotm.xp', true]]);
    expect(mined.yields[1]!.per).toEqual([0.2 * 0.85, 0.2 * 1.15]);
    const fresh = withLearnedLinks(combos, { 'collect.hard_stone': { 'skills.mining.xp': { rate: 1, sessions: 2 }, 'collections.HARD_STONE': { rate: 1, sessions: 5 } } }, catalogue, book, () => 'Hard Stone');
    expect(fresh.find((c) => c.id === 'combo.learned.collect.hard_stone')).toMatchObject({
      name: 'Hard Stone (from your sessions)', primary: 'collect.hard_stone', primaryMetrics: ['collections.HARD_STONE'], yields: [{ metric: 'skills.mining.xp', learned: true }],
    }); // its own metric is never a yield
    expect(combos.find((c) => c.id === 'combo.mine.mithril_ore')!.yields).toHaveLength(1); // the shared list is untouched
  });

  it(`links only when the latest sessions agree within ${LINK_MAX_SPREAD}x, so background gains stay out`, () => {
    const one = blend(undefined, 0.144, 48, 'a');
    expect(linkStatus(one)).toBe('pending');
    expect(linkStatus(blend(one, 0.2, 30, 'b'))).toBe('ready');
    // Honeycomb from a minion: 0.019 per item one session, 0.003 the next.
    const honey = blend(blend(undefined, 0.019, 24, 'a'), 0.003, 48, 'b');
    expect(linkStatus(honey)).toBe('inconsistent');
    expect(withLearnedLinks(loadCombos(catalogue, book), { 'collect.mithril_ore': { 'collections.HONEYCOMB': honey } }, catalogue, book, (a) => a)
      .find((c) => c.id === 'combo.mine.mithril_ore')!.yields.map((y) => y.metric)).toEqual(['skills.mining.xp']);
    // A later session that agrees again brings it back.
    expect(linkStatus(blend(honey, 0.004, 40, 'c'))).toBe('ready');
    // Links saved before history was kept count on sessions alone.
    expect(linkStatus({ rate: 0.2, sessions: 2 })).toBe('ready');
  });

  it('ignores stats the player names, remembered per profile', async () => {
    expect(findMetric(catalogue, 'honeycomb')).toBe('collections.HONEYCOMB');
    expect(findMetric(catalogue, 'HOTM XP')).toBe('hotm.xp');
    expect(findMetric(catalogue, '  ')).toBeUndefined();
    const u = new UserData(await mkdtemp(join(tmpdir(), 'xpbot-ignore-')));
    expect(await u.setIgnored('k', 'collections.HONEYCOMB', true)).toBe(true);
    expect(await u.setIgnored('k', 'collections.HONEYCOMB', true)).toBe(false);
    expect([...await u.getIgnored('k')]).toEqual(['collections.HONEYCOMB']);
    expect((await u.getIgnored('other')).size).toBe(0);
    const links = { 'collect.mithril_ore': { 'collections.HONEYCOMB': { rate: 0.01, sessions: 3 }, 'hotm.xp': { rate: 0.2, sessions: 2 } } };
    const mined = (ignored: Set<string>) => withLearnedLinks(loadCombos(catalogue, book), links, catalogue, book, (a) => a, ignored)
      .find((c) => c.id === 'combo.mine.mithril_ore')!.yields.map((y) => y.metric);
    expect(mined(await u.getIgnored('k'))).toEqual(['skills.mining.xp', 'hotm.xp']);
    expect(await u.setIgnored('k', 'collections.HONEYCOMB', false)).toBe(true);
    expect(mined(await u.getIgnored('k'))).toEqual(['skills.mining.xp', 'collections.HONEYCOMB', 'hotm.xp']);
  });

  it('labels metrics by what they count', () => {
    expect(metricLabel(catalogue, 'hotm.xp')).toBe('HOTM XP');
    expect(metricLabel(catalogue, 'skills.mining.xp')).toBe('Mining XP');
    expect(metricLabel(catalogue, 'slayer.blaze.xp')).toBe('Inferno Demonlord Slayer XP');
    expect(metricLabel(catalogue, 'garden.crop_milestone.WHEAT')).toBe('Wheat Crop milestone');
    expect(metricLabel(catalogue, 'collections.HARD_STONE')).toBe('Hard Stone collection');
  });

  it('stores links per profile and activity, and reads old combo IDs as their new ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xpbot-link-'));
    const u = new UserData(dir);
    await u.setActivityLink('k', 'collect.mithril_ore', 'hotm.xp', blend(undefined, 0.2, 30, 't'));
    expect(await u.getActivityLinks('k')).toMatchObject({ 'collect.mithril_ore': { 'hotm.xp': { rate: 0.2, sessions: 1 } } });
    await u.setComboRatio('k', 'combo.combat.zealot', 'skills.combat.xp', blend(undefined, 100, 30, 't'));
    expect(await u.getComboRatioNumbers('k')).toEqual({ 'combo.mob.combat_3.zealot': { 'skills.combat.xp': 100 } });
  });
});
