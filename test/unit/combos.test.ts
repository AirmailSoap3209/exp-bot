import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCombos, ComboError, loadCombos, yieldPer } from '../../src/combos/combos.js';
import { loadRates } from '../../src/estimate/rates.js';
import { loadCatalogue } from '../../src/tasks/catalogue.js';

const catalogue = loadCatalogue();
const book = loadRates();

describe('combo data', () => {
  const combos = loadCombos(catalogue, book);
  const byId = new Map(combos.map((c) => [c.id, c]));

  it('loads every combo, sorted by ID', () => {
    const ids = combos.map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(ids.filter((id) => /^combo\.(dungeons|slayer)\./.test(id))).toEqual([
      'combo.dungeons.f0', 'combo.dungeons.f1', 'combo.dungeons.f2', 'combo.dungeons.f3', 'combo.dungeons.f4', 'combo.dungeons.f5', 'combo.dungeons.f6', 'combo.dungeons.f7',
      'combo.slayer.blaze', 'combo.slayer.enderman', 'combo.slayer.spider', 'combo.slayer.wolf', 'combo.slayer.zombie',
    ]);
  });

  it('generates a gathering combo for every collection whose block gives skill XP on the wiki', () => {
    const src = JSON.parse(readFileSync(new URL('../../data/sources/combo-sources.json', import.meta.url), 'utf8')) as { gathering: Record<string, Record<string, unknown>> };
    for (const [skill, items] of Object.entries(src.gathering)) {
      for (const item of Object.keys(items)) {
        const c = combos.find((x) => x.primary === `collect.${item.toLowerCase().replace(/:/g, '-')}`);
        expect(c, item).toBeDefined();
        expect(c!.yields[0]!.metric).toBe(`skills.${skill}.xp`);
        // Every crop is farmed in the Garden, so it also counts toward the crop's milestone.
        if (skill === 'farming') expect(c!.yields.map((y) => y.metric)).toContain(`garden.crop_milestone.${item}`);
      }
    }
    expect(Object.values(src.gathering).reduce((n, items) => n + Object.keys(items).length, 0)).toBe(43);
    // Base drops divide the per-item XP: lapis drops 4-9 per block.
    expect(yieldPer(byId.get('combo.mine.ink_sack-4')!.yields[0]!, 'early')).toEqual([0.389, 1.75]);
  });

  it('generates a mob combo for every grindable family with wiki kill data, and slayer quests with their spawn mob', () => {
    const mobs = JSON.parse(readFileSync(new URL('../../data/sources/wiki-mobs.json', import.meta.url), 'utf8')) as { families: Record<string, unknown> };
    for (const id of Object.keys(mobs.families)) expect(byId.get(`combo.mob.${id}`), id).toBeDefined();
    expect(byId.get('combo.mob.combat_3.zealot')).toMatchObject({ name: 'Kill Zealots', location: 'The End', yields: [{ metric: 'skills.combat.xp', per: [109, 109] }, { metric: 'collections.ENDER_PEARL', per: [4, 4] }] });
    expect(byId.get('combo.mob.combat_3.enderman')!.name).toBe('Kill Endermen');
    // Revenant: 5,000 Combat XP to spawn a T4 (500 slayer XP) from 49 XP Crypt Ghouls = 0.204 kills per slayer XP.
    const rev = byId.get('combo.slayer.zombie')!;
    expect(rev.yields.map((y) => y.metric)).toEqual(['skills.combat.xp', 'bestiary.family.hub.crypt_ghoul', 'collections.ROTTEN_FLESH']);
    expect(yieldPer(rev.yields[1]!, 'mid')).toEqual([0.204, 0.204]);
    expect(byId.get('combo.slayer.spider')!.yields.map((y) => y.metric)).toEqual(['skills.combat.xp']);
  });

  it('works out what the primary advances from the tasks that use it', () => {
    expect(byId.get('combo.farm.wheat')!.primaryMetrics).toEqual(['collections.WHEAT']);
    expect(byId.get('combo.slayer.zombie')!.primaryMetrics).toEqual(['slayer.zombie.xp']);
    expect(byId.get('combo.mob.combat_3.zealot')!.primaryMetrics).toEqual(['bestiary.family.combat_3.zealot']);
  });

  it('picks the bracket range for gear-dependent yields, and the fixed range otherwise', () => {
    const farm = byId.get('combo.farm.wheat')!.yields[0]!;
    expect(yieldPer(farm, 'early')).toEqual([2, 4]);
    expect(yieldPer(farm, 'late')).toEqual([0.211, 0.364]);
    const pearls = byId.get('combo.mob.combat_3.zealot')!.yields.find((y) => y.metric === 'collections.ENDER_PEARL')!;
    expect(yieldPer(pearls, 'early')).toEqual([4, 4]);
    expect(yieldPer(pearls, 'late')).toEqual([4, 4]);
  });
});

describe('combo validation', () => {
  const ok = { id: 'combo.x', name: 'X', primary: 'collect.wheat', yields: [{ metric: 'skills.farming.xp', per: [1, 2], basis: 'b' }] };
  const check = (combo: Record<string, unknown>, extra: Record<string, unknown>[] = []) =>
    buildCombos([{ name: 'combos/t.json', data: { source: 's', combos: [combo, ...extra] } }], catalogue, book).problems;

  it('accepts a valid combo', () => expect(check(ok)).toEqual([]));

  it.each([
    [{ ...ok, id: 'x' }, /id must be a string starting with "combo\."/],
    [{ ...ok, primary: 'collect.nope' }, /has no rate/],
    [{ ...ok, primary: 'nope' }, /no task uses primary nope/],
    [{ ...ok, yields: [] }, /yields must be a non-empty array/],
    [{ ...ok, yields: [{ metric: 'nope', per: [1, 1], basis: 'b' }] }, /isn't used by any task/],
    [{ ...ok, yields: [{ metric: 'collections.WHEAT', per: [1, 1], basis: 'b' }] }, /the primary's own metric/],
    [{ ...ok, yields: [{ metric: 'skills.farming.xp', per: [2, 1], basis: 'b' }] }, /per must be/],
    [{ ...ok, yields: [{ metric: 'skills.farming.xp', per: { early: [1, 1], mid: [1, 1] }, basis: 'b' }] }, /per must be/],
    [{ ...ok, yields: [{ metric: 'skills.farming.xp', per: [1, 1] }] }, /needs a basis/],
    [{ ...ok, yields: [ok.yields[0], ok.yields[0]] }, /listed twice/],
  ])('rejects %j', (combo, problem) => expect(check(combo).join('\n')).toMatch(problem));

  it('rejects fixed-time activities as a primary (they have no rate)', () => {
    expect(check({ ...ok, primary: 'minion.wheat' }).join('\n')).toMatch(/has no rate/);
  });

  it('rejects duplicate IDs across combos and a malformed file', () => {
    expect(check(ok, [ok]).join('\n')).toMatch(/duplicate id/);
    expect(buildCombos([{ name: 'combos/bad.json', data: { combos: [] } }], catalogue, book).problems).toEqual(['combos/bad.json: must be { source: string, combos: [...] }']);
  });

  it('loadCombos throws on any problem', () => {
    expect(() => loadCombos(catalogue, book, 'test/fixtures')).toThrow(ComboError);
  });
});
