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
    expect(combos.map((c) => c.id)).toEqual([
      'combo.combat.blaze', 'combo.combat.crypt_ghoul', 'combo.combat.enderman', 'combo.combat.ghast', 'combo.combat.magma_cube', 'combo.combat.zealot',
      'combo.dungeons.f0', 'combo.dungeons.f1', 'combo.dungeons.f2', 'combo.dungeons.f3', 'combo.dungeons.f4', 'combo.dungeons.f5', 'combo.dungeons.f6', 'combo.dungeons.f7',
      'combo.farm.cactus', 'combo.farm.pumpkin', 'combo.farm.sugar_cane', 'combo.farm.wheat',
      'combo.slayer.blaze', 'combo.slayer.enderman', 'combo.slayer.spider', 'combo.slayer.wolf', 'combo.slayer.zombie',
    ]);
  });

  it('works out what the primary advances from the tasks that use it', () => {
    expect(byId.get('combo.farm.wheat')!.primaryMetrics).toEqual(['collections.WHEAT']);
    expect(byId.get('combo.slayer.zombie')!.primaryMetrics).toEqual(['slayer.zombie.xp']);
    expect(byId.get('combo.combat.zealot')!.primaryMetrics).toEqual(['bestiary.family.combat_3.zealot']);
  });

  it('picks the bracket range for gear-dependent yields, and the fixed range otherwise', () => {
    const farm = byId.get('combo.farm.wheat')!.yields[0]!;
    expect(yieldPer(farm, 'early')).toEqual([2, 4]);
    expect(yieldPer(farm, 'late')).toEqual([0.211, 0.364]);
    const pearls = byId.get('combo.combat.zealot')!.yields.find((y) => y.metric === 'collections.ENDER_PEARL')!;
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
