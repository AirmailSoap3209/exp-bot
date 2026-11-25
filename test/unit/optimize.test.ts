import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatEntry, formatMinutes, optimizeEmbed, pageButtons } from '../../src/commands/optimize.js';
import { resolveBracket } from '../../src/estimate/brackets.js';
import { estimateTask } from '../../src/estimate/estimate.js';
import { loadRates } from '../../src/estimate/rates.js';
import type { ProfilesResponse } from '../../src/hypixel/client.js';
import { rankTasks } from '../../src/optimizer/rank.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import type { NormalizedProfile } from '../../src/profile/types.js';
import { loadCatalogue } from '../../src/tasks/catalogue.js';
import { evaluateProgress, type TaskProgress } from '../../src/tasks/progress.js';

const catalogue = loadCatalogue();
const book = loadRates();
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
const skills = read<SkillsResource>('../fixtures/resource-skills.json');
function profile(player: string, name: string): NormalizedProfile {
  const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>(`../fixtures/profiles-${player}.json`);
  return normalizeProfile(pickProfile(response.profiles, name)!, uuid, skills, 0);
}
const lime = profile('floor7sweat', 'lime');
const limeProgress = evaluateProgress(catalogue, lime).progress;
const P = new Map(limeProgress.map((p) => [p.task.id, p]));

describe('rate data', () => {
  it('has a rate for every activity of a task without fixed minutes', () => {
    const missing = catalogue.tasks.filter((t) => !t.minutes && t.activity && !book.rates.has(t.activity)).map((t) => t.activity);
    expect([...new Set(missing)]).toEqual([]);
  });
  it('gives every task either fixed minutes or an activity', () => {
    expect(catalogue.tasks.filter((t) => !t.minutes && !t.activity)).toEqual([]);
  });
});

describe('brackets', () => {
  it('combat uses the weaker of combat level and highest slayer level', () => {
    // Lime: combat 42 (late from 45), highest slayer 7 (late from 8): both mid
    expect(resolveBracket('combat', lime, book.brackets)).toMatchObject({ bracket: 'mid', known: true, detail: 'combat 42, slayer 7' });
    const weakSlayer = structuredClone(lime);
    if (weakSlayer.slayer.available) for (const b of Object.values(weakSlayer.slayer.value)) b.level = Math.min(b.level, 3);
    expect(resolveBracket('combat', weakSlayer, book.brackets).bracket).toBe('early');
  });
  it('single inputs use their own cut-offs', () => {
    expect(resolveBracket('skill.farming', lime, book.brackets)).toMatchObject({ bracket: 'mid', detail: 'farming 35' }); // skills: [25, 45]
    expect(resolveBracket('dungeons', lime, book.brackets)).toMatchObject({ bracket: 'mid', detail: 'catacombs 33' }); // [30, 45]
    const raspberry = profile('ducksterr_', 'raspberry');
    expect(resolveBracket('slayer.zombie', raspberry, book.brackets)).toMatchObject({ bracket: 'late', detail: 'slayer.zombie 8' });
  });
  it('falls back to early, flagged, when the profile has no data', () => {
    const apple = profile('floor7sweat', 'apple');
    expect(resolveBracket('skill.mining', apple, book.brackets)).toMatchObject({ bracket: 'early', known: false });
  });
});

describe('estimateTask', () => {
  const zombie8 = P.get('slayer.zombie.level8')!; // 295,695 slayer XP left
  const rate = book.rates.get('slayer.zombie')!;

  it('default: remaining / bracket rate, as a range', () => {
    const e = estimateTask(zombie8, lime, { book })!;
    const [lo, hi] = rate.brackets[e.bracket!];
    expect(e).toMatchObject({ source: 'default', bracket: 'mid', unit: 'slayer XP' }); // slayer 7: mid until 8
    expect(e.minutes[0]).toBeCloseTo(295695 / hi);
    expect(e.minutes[1]).toBeCloseTo(295695 / lo);
    expect(e.xpPerMin).toBeCloseTo(150 / e.midMinutes);
  });

  it('session beats override beats default', () => {
    const overrides = { 'slayer.zombie': { bracket: 'early', setAt: '' } };
    expect(estimateTask(zombie8, lime, { book, overrides })).toMatchObject({ source: 'override', bracket: 'early' });
    const num = estimateTask(zombie8, lime, { book, overrides: { 'slayer.zombie': { rate: 1000, setAt: '' } } })!;
    expect(num.source).toBe('override');
    expect(num.minutes[0]).toBeCloseTo(295695 / 1150);
    expect(num.minutes[1]).toBeCloseTo(295695 / 850);
    expect(estimateTask(zombie8, lime, { book, overrides, sessionRates: { 'slayer.zombie': 500 } })).toMatchObject({ source: 'session' });
  });

  it('fixed-minute tasks skip rates', () => {
    expect(estimateTask(P.get('fairy_souls.exchange38')!, lime, { book })).toMatchObject({ source: 'fixed', minutes: [2, 6], midMinutes: 4 });
  });

  it('assumes the whole requirement when the API gives no number', () => {
    const p: TaskProgress = { ...P.get('catacombs.master6')!, current: null, remaining: null };
    expect(estimateTask(p, lime, { book })).toMatchObject({ assumedNoProgress: true });
  });
});

describe('rankTasks', () => {
  const result = rankTasks(limeProgress, lime, { book }, { limit: 10 });

  it('returns 10 tasks sorted by midpoint, all eligible', () => {
    expect(result.ranked).toHaveLength(10);
    const mids = result.ranked.map((r) => r.estimate.midMinutes);
    expect(mids).toEqual([...mids].sort((a, b) => a - b));
    for (const { progress: p } of result.ranked) {
      expect(['verified_incomplete', 'estimated']).toContain(p.status);
      expect(p.likelyComplete).toBe(false);
      expect(p.blocked).toBeUndefined();
    }
  });

  it('keeps one tier per source and respects prerequisites', () => {
    const all = rankTasks(limeProgress, lime, { book }, { limit: 100_000 }).ranked;
    const groups = all.map((r) => r.progress.task.group).filter(Boolean);
    expect(new Set(groups).size).toBe(groups.length);
    expect(all.some((r) => r.progress.task.id === 'slayer.zombie.level9')).toBe(false); // level 8 not done yet
    expect(all.some((r) => r.progress.task.id === 'slayer.zombie.level8')).toBe(true);
    expect(all.some((r) => r.progress.task.id === 'skills.farming.level51')).toBe(false); // above the cap
  });

  it('drops excluded categories, and never ranks unavailable data', () => {
    const noBest = rankTasks(limeProgress, lime, { book }, { excluded: new Set(['bestiary']), limit: 50 });
    expect(noBest.ranked.some((r) => r.progress.task.category === 'bestiary')).toBe(false);
    expect(noBest.dropped.excluded).toBe(catalogue.byCategory.get('bestiary')!.length);
    const pine = profile('floor7sweat', 'pineapple');
    const pr = rankTasks(evaluateProgress(catalogue, pine).progress, pine, { book }, { limit: 100_000 });
    expect(pr.ranked.every((r) => r.progress.status !== 'unavailable')).toBe(true);
    expect(pr.dropped.unavailable).toBeGreaterThan(0);
  });

  it('drops excluded sources, every tier of them', () => {
    const all = rankTasks(limeProgress, lime, { book }, { limit: 100_000 });
    const top = all.ranked[0]!.progress.task;
    const without = rankTasks(limeProgress, lime, { book }, { excludedSources: new Set([top.group!]), limit: 100_000 });
    expect(without.ranked.some((r) => r.progress.task.group === top.group)).toBe(false);
    expect(without.ranked.length).toBe(all.ranked.length - 1);
    expect(without.dropped.excluded).toBeGreaterThan(0);
  });

  it('breaks ties by XP', () => {
    const base = P.get('fairy_souls.exchange38')!;
    // Ranked alone, so drop prerequisites (a missing prerequisite counts as unfinished).
    const a = { ...base, task: { ...base.task, id: 'a', xp: 1, group: 'a', prerequisites: [] } };
    const b = { ...base, task: { ...base.task, id: 'b', xp: 9, group: 'b', prerequisites: [] } };
    expect(rankTasks([a, b], lime, { book }).ranked.map((r) => r.progress.task.id)).toEqual(['b', 'a']);
  });
});

describe('formatting', () => {
  it.each([
    [[0.2, 0.5], '<1 min'],
    [[0.5, 3], '~<1–3 min'],
    [[1, 3], '~1–3 min'],
    [[5, 5.2], '~5 min'],
    [[30, 90], '~0.5–1.5 h'],
    [[120, 300], '~2–5 h'],
    [[900, 1800], '~15–30 h'],
    [[2000, 2800], '~33–47 h'],
    [[4320, 8640], '~3–6 days'],
    [[1_628_340, 4_106_340], '~1,131–2,852 days'],
  ] as [[number, number], string][])('formatMinutes(%j) = %s', (r, s) => expect(formatMinutes(r)).toBe(s));

  it('formats an entry in the four-line spec layout', () => {
    const z = P.get('slayer.zombie.level8')!;
    const r = rankTasks([{ ...z, task: { ...z.task, prerequisites: [] } }], lime, { book }).ranked[0]!;
    const lines = formatEntry(1, r).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('**1. Revenant Horror Slayer level 8**');
    expect(lines[1]).toBe('Progress 104,305/400,000 slayer XP · 295,695 left · +150 XP');
    expect(lines[2]).toMatch(/^~[\d.]+–[\d.]+ h \(mid bracket\) · [\d.]+ XP\/min$/);
    expect(lines[3]).toBe('Crypts, Hub · verified');
  });

  it('pages 5 at a time with Prev/Next, within Discord limits', () => {
    const result = rankTasks(limeProgress, lime, { book }, { limit: 10 });
    const p1 = optimizeEmbed('Floor7Sweat', lime, result, 0, { now: 0 }).toJSON();
    const p2 = optimizeEmbed('Floor7Sweat', lime, result, 1, { now: 0 }).toJSON();
    expect(p1.description).toContain('**1. ');
    expect(p1.description).not.toContain('**6. ');
    expect(p2.description).toContain('**6. ');
    expect(p1.footer?.text).toBe('Lime · data 0s old · monetary tasks excluded · page 1/2');
    expect((p1.description ?? '').length).toBeLessThanOrEqual(4096);
    const [prev, next] = pageButtons('abc', 0, 10).toJSON().components as { disabled?: boolean; custom_id?: string }[];
    expect(prev).toMatchObject({ disabled: true, custom_id: 'xpopt:abc:-1' });
    expect(next).toMatchObject({ disabled: false, custom_id: 'xpopt:abc:1' });
  });
});
