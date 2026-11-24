import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProfilesResponse } from '../../src/hypixel/client.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import type { NormalizedProfile } from '../../src/profile/types.js';
import { loadCatalogue } from '../../src/tasks/catalogue.js';
import { decideTick, evaluateProgress, evaluateTask, STATUSES, summarize, type TaskProgress } from '../../src/tasks/progress.js';
import { overviewEmbed } from '../../src/commands/overview.js';

const catalogue = loadCatalogue();
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
const skills = read<SkillsResource>('../fixtures/resource-skills.json');

function profile(player: string, name: string): NormalizedProfile {
  const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>(`../fixtures/profiles-${player}.json`);
  return normalizeProfile(pickProfile(response.profiles, name)!, uuid, skills, 0);
}

const lime = profile('floor7sweat', 'lime');
const evalLime = evaluateProgress(catalogue, lime);
const byId = (e: { progress: TaskProgress[] }) => new Map(e.progress.map((p) => [p.task.id, p]));
const L = byId(evalLime);

describe('evaluateProgress on Lime', () => {
  it('gives every task exactly one status and no reader misses a metric', () => {
    expect(evalLime.progress).toHaveLength(catalogue.tasks.length);
    const unknown = evalLime.progress.filter((p) => p.reason?.startsWith('Reader does not know metric'));
    expect(unknown.map((p) => p.task.id)).toEqual([]);
  });

  it('slayer: levels from XP, boss tiers from the completed-task list', () => {
    expect(L.get('slayer.zombie.level7')!.status).toBe('verified_complete');
    expect(L.get('slayer.zombie.level8')).toMatchObject({ status: 'verified_incomplete', current: 104305, remaining: 400000 - 104305 });
    expect(L.get('slayer.zombie.tier5')!.status).toBe('verified_complete'); // DEFEAT_ZOMBIE_SLAYER_FIVE
    expect(L.get('slayer.blaze.tier1')).toMatchObject({ status: 'verified_incomplete', current: 0, remaining: 1 });
  });

  it('catacombs: floors and master floors', () => {
    expect(L.get('catacombs.floor7')!.status).toBe('verified_complete');
    expect(L.get('catacombs.master5')!.status).toBe('verified_complete');
    expect(L.get('catacombs.master6')).toMatchObject({ status: 'verified_incomplete', remaining: 1 });
    expect(L.get('catacombs.level33')!.status).toBe('verified_complete');
    expect(L.get('catacombs.level34')!.status).toBe('verified_incomplete');
  });

  it('skills: completion follows the level, and levels past the cap are blocked', () => {
    expect(L.get('skills.combat.level42')!.status).toBe('verified_complete');
    expect(L.get('skills.combat.level43')).toMatchObject({ status: 'verified_incomplete', blocked: undefined });
    expect(L.get('skills.farming.level51')).toMatchObject({ status: 'verified_incomplete', blocked: 'farming level cap is 50' });
  });

  it('bestiary: family tiers are estimated, milestones verified', () => {
    const t1 = L.get('bestiary.hub.crypt_ghoul.tier1')!;
    expect(t1.status).toBe('estimated');
    expect(L.get('bestiary.milestone150')!.status).toBe('verified_complete');
    expect(L.get('bestiary.milestone160')).toMatchObject({ status: 'verified_incomplete', current: 154, remaining: 6 });
  });

  it('collections, minions, fairy souls', () => {
    expect(L.get('collections.wheat.tier1')!.status).toBe('verified_complete');
    expect(L.get('minions.snow.tier1')!.status).toBe('verified_complete');
    expect(L.get('fairy_souls.exchange37')!.status).toBe('verified_complete');
    expect(L.get('fairy_souls.exchange38')).toMatchObject({ status: 'verified_incomplete', current: 37, remaining: 1 });
  });
});

describe('missing data', () => {
  const pineapple = byId(evaluateProgress(catalogue, profile('floor7sweat', 'pineapple')));

  it('collections with own API off: unlocked tiers verified, the rest unavailable (never zero)', () => {
    const coll = [...pineapple.values()].filter((p) => p.task.category === 'collections');
    expect(coll.some((p) => p.status === 'verified_complete')).toBe(true);
    const notDone = coll.filter((p) => p.status !== 'verified_complete');
    expect(notDone.length).toBeGreaterThan(0);
    expect(notDone.every((p) => p.status === 'unavailable' && p.current === null)).toBe(true);
  });

  it('absent sections are unavailable, but the task list still proves incomplete one-time tasks', () => {
    expect(pineapple.get('bestiary.milestone10')!.status).toBe('unavailable');
    expect(pineapple.get('fairy_souls.exchange1')!.status).toBe('unavailable');
    expect(pineapple.get('slayer.zombie.level1')!.status).toBe('unavailable');
    // Not in Pineapple's completed_tasks, so verified incomplete even without slayer data.
    expect(pineapple.get('slayer.zombie.tier1')).toMatchObject({ status: 'verified_incomplete', current: null });
  });
});

describe('ticks', () => {
  const task = (id: string) => catalogue.byId.get(id)!;

  it('API wins over a tick when it proves the task incomplete, and the tick is cleared', () => {
    const r = evaluateTask(task('slayer.zombie.level8'), lime, true);
    expect(r.progress.status).toBe('verified_incomplete');
    expect(r.clearTick).toBe(true);
    const all = evaluateProgress(catalogue, lime, new Set(['slayer.zombie.level8', 'slayer.zombie.level7']));
    expect(all.ticksToClear).toEqual(['slayer.zombie.level8']);
  });

  it('a tick holds where the API cannot decide', () => {
    expect(evaluateTask(task('bestiary.hub.crypt_ghoul.tier20'), lime, true)).toMatchObject({ progress: { status: 'ticked' }, clearTick: false });
    const pineapple = profile('floor7sweat', 'pineapple');
    expect(evaluateTask(task('fairy_souls.exchange1'), pineapple, true)).toMatchObject({ progress: { status: 'ticked' }, clearTick: false });
  });
});

describe('summarize', () => {
  it('buckets add up and match the status counts', () => {
    const s = summarize(evalLime.progress);
    const n = STATUSES.reduce((a, st) => a + s.counts[st], 0);
    expect(n).toBe(catalogue.tasks.length);
    const total = s.earned + s.remaining + s.likelyComplete + s.unknown;
    expect(total).toBe(catalogue.tasks.reduce((a, t) => a + t.xp, 0));
    // Catalogue XP earned can't exceed the player's real SkyBlock XP.
    expect(s.earned).toBeLessThanOrEqual(lime.leveling.experience);
  });

  it('builds an overview embed that fits Discord limits', () => {
    const json = overviewEmbed('Floor7Sweat', lime, summarize(evalLime.progress), catalogue, { now: 30_000 }).toJSON();
    expect(json.footer?.text).toBe('Lime · data 30s old · ticks not applied · monetary tasks excluded');
    for (const f of json.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
  });

  it('leaves excluded categories out of eligible XP', () => {
    const all = summarize(evalLime.progress);
    const noBestiary = summarize(evalLime.progress, new Set(['bestiary']));
    const best = all.byCategory.get('bestiary')!;
    expect(noBestiary.byCategory.has('bestiary')).toBe(false);
    expect(noBestiary.earned).toBe(all.earned - best.earned);
    expect(noBestiary.remaining).toBe(all.remaining - best.remaining);
    const json = overviewEmbed('Floor7Sweat', lime, noBestiary, catalogue, { excluded: new Set(['bestiary']), isLinked: true }).toJSON();
    expect(json.description).toContain('Excluded by you: Bestiary');
    expect(json.footer?.text).toContain('your linked profile');
  });
});

describe('decideTick', () => {
  const task = (id: string) => catalogue.byId.get(id)!;
  it('refuses tasks the API already decides, allows the rest', () => {
    expect(decideTick(task('slayer.zombie.level7'), lime)).toMatchObject({ ok: false, why: 'already_complete' });
    expect(decideTick(task('slayer.zombie.level8'), lime)).toMatchObject({ ok: false, why: 'api_incomplete', progress: { current: 104305 } });
    expect(decideTick(task('bestiary.hub.crypt_ghoul.tier20'), lime)).toEqual({ ok: true });
    expect(decideTick(task('fairy_souls.exchange1'), profile('floor7sweat', 'pineapple'))).toEqual({ ok: true });
  });
});
