import { describe, expect, it } from 'vitest';
import { estimateTask } from '../../src/estimate/estimate.js';
import { loadRates } from '../../src/estimate/rates.js';
import type { NormalizedProfile } from '../../src/profile/types.js';
import { applyAccess } from '../../src/tasks/access.js';
import { loadCatalogue } from '../../src/tasks/catalogue.js';
import type { TaskProgress } from '../../src/tasks/progress.js';
import type { Access, AccessArea } from '../../src/tasks/types.js';

/** Just what applyAccess reads: skill levels (or none) and the SkyBlock level. */
const profile = (skills: Record<string, number> | null, level = 100) =>
  ({
    skills: skills ? { available: true, value: Object.fromEntries(Object.entries(skills).map(([k, l]) => [k, { level: l }])) } : { available: false, reason: 'off' },
    leveling: { level },
  }) as unknown as NormalizedProfile;

function tp(id: string, access: Access, current = 0, status: TaskProgress['status'] = 'verified_incomplete'): TaskProgress {
  return {
    task: { id, category: 'x', name: id, description: id, xp: 1, requires: { metric: `m.${id}`, amount: 10 }, prerequisites: [], activity: 'a', monetary: false, tracking: 'api', source: 't', access },
    status, current, required: 10, remaining: 10 - current, likelyComplete: false,
  };
}
const crimson: AccessArea = { id: 'crimson_isle', name: 'Crimson Isle', skills: { combat: 22 } };
const hollows: AccessArea = { id: 'crystal_hollows', name: 'Crystal Hollows', skills: { mining: 12 }, other: ['Heart of the Mountain tier 4'] };
const garden: AccessArea = { id: 'garden', name: 'The Garden', sbLevel: 5 };
const blocked = (list: TaskProgress[]) => Object.fromEntries(list.map((p) => [p.task.id, p.blocked]));

describe('applyAccess', () => {
  it('checks skill and SkyBlock levels against the profile', () => {
    const list = [tp('ghast', { anyOf: [crimson] }), tp('flower', { anyOf: [garden] })];
    expect(blocked(applyAccess(list, profile({ combat: 22 }, 5)))).toEqual({ ghast: undefined, flower: undefined });
    expect(blocked(applyAccess(list, profile({ combat: 21 }, 4)))).toEqual({
      ghast: 'Needs Crimson Isle access: Combat 22',
      flower: 'Needs The Garden access: SkyBlock level 5',
    });
  });

  it('treats missing skill data as unmet, and says so', () => {
    expect(applyAccess([tp('ghast', { anyOf: [crimson] })], profile(null))[0]!.blocked).toBe('Needs Crimson Isle access: Combat 22 (no skill data to check)');
  });

  it('needs progress in the area for requirements the API does not show', () => {
    const ore = tp('hard_stone', { anyOf: [hollows] });
    expect(applyAccess([ore], profile({ mining: 30 }))[0]!.blocked).toBe('Needs Crystal Hollows access: Heart of the Mountain tier 4 (not shown in the API)');
    // Another task done only in the Crystal Hollows shows progress, so the area is reachable.
    const kills = tp('automaton', { anyOf: [hollows] }, 3, 'estimated');
    expect(blocked(applyAccess([ore, kills], profile({ mining: 30 })))).toEqual({ hard_stone: undefined, automaton: undefined });
  });

  it('never blocks a task with progress of its own', () => {
    expect(applyAccess([tp('ghast', { anyOf: [crimson] }, 4)], profile({ combat: 1 }))[0]!.blocked).toBeUndefined();
  });

  it('any one area is enough; any-of progress does not prove a single area', () => {
    const gem = tp('gem', { anyOf: [hollows, crimson] });
    expect(applyAccess([gem], profile({ combat: 22, mining: 1 }))[0]!.blocked).toBeUndefined();
    expect(applyAccess([gem], profile({ combat: 1, mining: 1 }))[0]!.blocked).toBe('Needs access to Crystal Hollows or Crimson Isle');
    const other = tp('quartz', { anyOf: [hollows] });
    expect(applyAccess([other, tp('gem2', { anyOf: [hollows, crimson] }, 5)], profile({ mining: 30 }))[0]!.blocked).toMatch(/Heart of the Mountain/);
  });

  it('checks requirements that hold everywhere, like a sea creature Fishing level', () => {
    const jawbus = tp('jawbus', { anyOf: [crimson], skills: { fishing: 45 } });
    expect(applyAccess([jawbus], profile({ combat: 30, fishing: 44 }))[0]!.blocked).toBe('Needs Fishing 45');
    expect(applyAccess([jawbus], profile({ combat: 30, fishing: 45 }))[0]!.blocked).toBeUndefined();
    const chili = tp('chili', { anyOf: [crimson], other: ['an Inferno Minion'] });
    expect(applyAccess([chili], profile({ combat: 30 }))[0]!.blocked).toBe('Needs an Inferno Minion (not shown in the API)');
  });

  it('leaves done, unavailable and already-blocked tasks alone', () => {
    const done = tp('done', { anyOf: [crimson] }, 10, 'verified_complete');
    const none = { ...tp('none', { anyOf: [crimson] }), status: 'unavailable' as const, current: null };
    const cap = { ...tp('cap', { anyOf: [crimson] }), blocked: 'above the cap' };
    expect(blocked(applyAccess([done, none, cap], profile({ combat: 1 })))).toEqual({ done: undefined, none: undefined, cap: 'above the cap' });
  });
});

describe('generated access data (hypixelskyblock.minecraft.wiki, 2026-11-24)', () => {
  const c = loadCatalogue();
  const t = (id: string) => c.byId.get(id)!;

  it('gates collections, bestiary families and slayer bosses on where they are done', () => {
    expect(t('collections.glacite.tier1').access?.anyOf.map((a) => a.id)).toEqual(['glacite_tunnels']);
    expect(t('collections.gemstone_collection.tier1').access?.anyOf.map((a) => a.id)).toEqual(['crystal_hollows', 'crimson_isle']);
    expect(t('collections.chili_pepper.tier1').access?.other).toEqual(['an Inferno Minion running LEGENDARY Hypergolic fuel']);
    expect(t('collections.wheat.tier1').access).toBeUndefined();
    expect(t('bestiary.fishing_lava.ragnarok.tier1').access).toMatchObject({ anyOf: [{ id: 'crimson_isle' }], skills: { fishing: 47 } });
    expect(t('bestiary.fishing_fishing.squid.tier1').access).toEqual({ anyOf: [], skills: { fishing: 1 } });
    expect(t('bestiary.kuudra.kuudra_follower.tier1').access?.anyOf[0]?.id).toBe('kuudra');
    expect(t('bestiary.mining_3.glacite_walker.tier1').access?.anyOf[0]?.id).toBe('glacite_tunnels');
    expect(t('bestiary.hub.crypt_ghoul.tier1').access).toBeUndefined();
    expect(t('slayer.blaze.tier1').access?.anyOf[0]?.id).toBe('crimson_isle');
    expect(t('slayer.zombie.tier1').access).toBeUndefined();
  });

  it('gates dungeon-mob bestiary on the first floor the mob appears on', () => {
    expect(t('bestiary.catacombs.wither_husk.tier1').prerequisites).toEqual(['catacombs.floor6', 'catacombs.level24']);
    expect(t('bestiary.catacombs.fels.tier1').prerequisites).toEqual(['catacombs.floor4', 'catacombs.level14']);
    expect(t('bestiary.catacombs.zombie_grunt.tier1').prerequisites).toEqual(['skills.combat.level15']);
    expect(t('bestiary.catacombs.zombie_grunt.tier2').prerequisites).toEqual(['bestiary.catacombs.zombie_grunt.tier1']);
  });
});

describe('minimum time per boss or run', () => {
  const c = loadCatalogue();
  const book = loadRates();
  const noData = profile(null) as NormalizedProfile & { slayer: unknown; catacombs: unknown };
  Object.assign(noData, { slayer: { available: false }, catacombs: { available: false } });
  const est = (id: string, remaining: number) => {
    const task = c.byId.get(id)!;
    const p: TaskProgress = { task, status: 'verified_incomplete', current: task.requires.amount - remaining, required: task.requires.amount, remaining, likelyComplete: false };
    return estimateTask(p, noData, { book })!.minutes;
  };

  it('never estimates less than one slayer boss, dungeon run or Kuudra run', () => {
    expect(est('slayer.blaze.level1', 1)).toEqual([5, 10]); // early: 0.1-0.2 bosses/min
    expect(est('catacombs.level1', 1)).toEqual([8, 15]); // early: shortest run
    expect(est('bestiary.catacombs.zombie_grunt.tier1', 1)).toEqual([8, 15]);
    expect(est('bestiary.kuudra.kuudra_follower.tier1', 1)).toEqual([8, 15]);
  });

  it('leaves long tasks and other activities alone', () => {
    const long = est('slayer.zombie.level9', 600_000);
    expect(long[0]).toBeGreaterThan(10);
    expect(est('collections.wheat.tier1', 1)[1]).toBeLessThan(1);
  });

  it('uses Enchanting cut-offs 10/30: no Experiments rate below Enchanting 10', () => {
    const r = book.rates.get('skill.enchanting')!;
    expect(r.brackets.early).toEqual([100, 600]);
    expect(book.brackets.cutoffs['skill.enchanting']).toEqual([10, 30]);
  });
});
