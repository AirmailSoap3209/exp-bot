import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProfilesResponse } from '../../src/hypixel/client.js';
import { buildCatalogue, CatalogueError, loadCatalogue } from '../../src/tasks/catalogue.js';
import { buildCoverage, formatTotal } from '../../src/tasks/coverage.js';
import type { Meta, Task } from '../../src/tasks/types.js';
import { coverageEmbed } from '../../src/commands/xp.js';

const catalogue = loadCatalogue();
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;

/** Every member of every fixture profile. */
const members = ['floor7sweat', 'ducksterr_', 'dik9'].flatMap((f) => {
  const { response } = read<{ response: ProfilesResponse }>(`../fixtures/profiles-${f}.json`);
  return (response.profiles ?? []).flatMap((p) => Object.values(p.members) as Record<string, any>[]);
});

describe('real catalogue', () => {
  it('loads, validates, and has tasks in every v1 category', () => {
    for (const c of catalogue.meta.categories.filter((c) => c.status === 'v1')) {
      expect(catalogue.byCategory.get(c.id)?.length, c.id).toBeGreaterThan(0);
    }
    expect(catalogue.tasks.every((t) => !t.monetary)).toBe(true);
  });

  it('matches the wiki where the wiki is current', () => {
    const xp = (cat: string) => catalogue.byCategory.get(cat)!.reduce((a, t) => a + t.xp, 0);
    expect(xp('fairy_souls')).toBe(530);
    expect(xp('catacombs')).toBe(2760);
    expect(xp('slayer')).toBe(4920); // wiki 4,950: the 30 XP Riftstalker level gap
  });

  it('has a task for every completed slayer and dungeon task ID seen in real profiles', () => {
    const ids = new Set(catalogue.tasks.map((t) => t.hypixelTaskId).filter(Boolean));
    const seen = new Set(members.flatMap((m) => (m.leveling?.completed_tasks ?? []) as string[])
      .filter((id) => /^(DEFEAT_\w+_SLAYER_|COMPLETE_(MASTER_)?CATACOMBS\d)/.test(id)));
    expect(seen.size).toBeGreaterThan(20);
    expect([...seen].filter((id) => !ids.has(id))).toEqual([]);
  });

  it('has a task for every unlocked collection tier and crafted minion in real profiles', () => {
    const metrics = new Set(catalogue.tasks.map((t) => `${t.requires.metric}#${t.requires.amount}`));
    const collTiers = new Set(catalogue.byCategory.get('collections')!.map((t) => `${t.requires.metric.slice('collections.'.length)}_${t.tier}`));
    const rift = new Set(Object.keys(read<any>('../../data/sources/hypixel-collections.json').collections.RIFT.items));
    const unknownTiers = new Set<string>();
    const unknownMinions = new Set<string>();
    for (const m of members) {
      for (const tier of (m.player_data?.unlocked_coll_tiers ?? []) as string[]) {
        const item = tier.replace(/_-?\d+$/, '');
        // "_-1" entries are placeholders Hypixel stores for every collection seen.
        if (!collTiers.has(tier) && !rift.has(item) && !tier.endsWith('_-1')) unknownTiers.add(tier);
      }
      for (const g of (m.player_data?.crafted_generators ?? []) as string[]) {
        if (!metrics.has(`minions.crafted.${g}#1`)) unknownMinions.add(g);
      }
    }
    // Legacy tiers above today's maximum (Redstone and Birch once had more tiers).
    expect([...unknownTiers].sort()).toEqual(['LOG:2_10', 'REDSTONE_10', 'REDSTONE_11', 'REDSTONE_12', 'REDSTONE_13', 'REDSTONE_14', 'REDSTONE_15', 'REDSTONE_16']);
    expect([...unknownMinions]).toEqual([]);
  });

  it("maps every bestiary mob key on the players' own profiles to a family, except pre-migration keys", () => {
    const families = read<{ mobs: string[] }[]>('../../data/bestiary/families.json');
    const known = new Set(families.flatMap((f) => f.mobs));
    const unknown = new Set<string>();
    // Bestiary is per member, so only the fixture players themselves (co-op mates' kills never count for them).
    const own = ['floor7sweat', 'ducksterr_', 'dik9'].flatMap((f) => {
      const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>(`../fixtures/profiles-${f}.json`);
      return (response.profiles ?? []).map((p) => p.members[uuid] as Record<string, any>);
    });
    for (const m of own) {
      for (const [k, v] of Object.entries(m.bestiary?.kills ?? {})) if (typeof v === 'number' && !known.has(k)) unknown.add(k);
    }
    // Plain farm animal keys only appear on a migrated profile, next to the current farming_* keys.
    expect([...unknown].sort()).toEqual(['chicken_1', 'cow_1', 'pig_1', 'sheep_1']);
  });

  it('fits the coverage report in a Discord embed', () => {
    const json = coverageEmbed(buildCoverage(catalogue)).toJSON();
    for (const f of json.fields ?? []) expect(f.value.length, f.name).toBeLessThanOrEqual(1024);
    expect((json.description ?? '').length).toBeLessThanOrEqual(4096);
  });
});

// ---------- Validator ----------

const meta: Meta = {
  checked: '2026-11-24',
  guideCategories: [{ id: 'core', name: 'Core', maxXp: null, wikiEstimate: 100 }],
  categories: [
    { id: 'skills', name: 'Skills', status: 'v1', guide: 'core' },
    { id: 'museum', name: 'Museum', status: 'never', guide: 'core' },
  ],
};

const base = (over: Partial<Task> = {}): Task => ({
  id: 'skills.combat.level1', category: 'skills', name: 'Combat level 1', description: 'Reach Combat 1', xp: 5,
  requires: { metric: 'skills.combat.xp', amount: 50 }, prerequisites: [], activity: 'skill.combat',
  monetary: false, tracking: 'api', source: 'test', ...over,
});

function problems(entries: unknown[], file = 'tasks/skills.json', m = meta): string[] {
  try {
    buildCatalogue(m, [{ file, entries }]);
    return [];
  } catch (err) {
    if (err instanceof CatalogueError) return err.problems;
    throw err;
  }
}

describe('catalogue validation', () => {
  it('accepts a valid entry', () => expect(problems([base()])).toEqual([]));

  it.each([
    ['zero xp', { xp: 0 }, /xp must be a positive integer/],
    ['fractional xp', { xp: 1.5 }, /xp must be a positive integer/],
    ['bad tracking', { tracking: 'guess' as never }, /tracking must be one of/],
    ['missing metric', { requires: { metric: '', amount: 1 } }, /requires must be/],
    ['monetary not boolean', { monetary: 'no' as never }, /monetary must be true or false/],
    ['inverted minutes', { minutes: [10, 5] as [number, number] }, /minutes must be/],
    ['no activity and no minutes', { activity: null }, /needs fixed minutes/],
    ['wrong category', { category: 'museum' }, /does not match file/],
  ])('rejects %s', (_, over, msg) => {
    expect(problems([base(over)]).join('\n')).toMatch(msg);
  });

  it('rejects duplicates, unknown prerequisites and cycles', () => {
    const p = problems([
      base(),
      base(),
      base({ id: 'a', prerequisites: ['b'] }),
      base({ id: 'b', prerequisites: ['a'] }),
      base({ id: 'c', prerequisites: ['nope'] }),
    ]).join('\n');
    expect(p).toMatch(/duplicate task id skills.combat.level1/);
    expect(p).toMatch(/prerequisite cycle: .*a -> b -> a|b -> a -> b/);
    expect(p).toMatch(/c: unknown prerequisite nope/);
  });

  it('rejects non-monetary tasks in an excluded category, and unknown categories', () => {
    expect(problems([base({ id: 'museum.x', category: 'museum' })], 'tasks/museum.json').join()).toMatch(/must be monetary: true/);
    expect(problems([], 'tasks/garden.json').join()).toMatch(/no category "garden"/);
  });
});

describe('coverage totals', () => {
  const withTasks = (m: Meta, xp: number) => buildCatalogue(m, [{ file: 'tasks/skills.json', entries: [base({ xp })] }]);

  it('never shows 100% from an estimate', () => {
    const c = buildCoverage(withTasks(meta, 100)).total;
    expect(c).toMatchObject({ percent: 99.9, approximate: true, knownTotal: null, estimatedTotal: 100 });
    expect(formatTotal(c, meta.checked)).toMatch(/~99.9%.*wiki estimate/);
  });

  it('shows 100% only when an exact in-game total is met', () => {
    const exact: Meta = { ...meta, guideCategories: [{ ...meta.guideCategories[0]!, maxXp: 100 }] };
    expect(buildCoverage(withTasks(exact, 100)).total).toMatchObject({ percent: 100, approximate: false, knownTotal: 100 });
    expect(buildCoverage(withTasks(exact, 40)).total.percent).toBe(40);
  });

  it('reports the total as unknown when a category has neither max nor estimate', () => {
    const partial: Meta = { ...meta, guideCategories: [...meta.guideCategories, { id: 'x', name: 'X', maxXp: null, wikiEstimate: null }] };
    const t = buildCoverage(withTasks(partial, 5)).total;
    expect(t.percent).toBeNull();
    expect(formatTotal(t, meta.checked)).toMatch(/total unknown/);
  });
});

describe('unlock requirements (wiki, 2026-11-24)', () => {
  const pre = (id: string) => loadCatalogue().byId.get(id)!.prerequisites;
  it('chains slayer bosses and gates tiers on Combat and slayer level', () => {
    expect(pre('slayer.zombie.tier1')).toEqual([]);
    expect(pre('slayer.spider.tier1')).toEqual(['slayer.zombie.tier2']);
    expect(pre('slayer.spider.level1')).toEqual(['slayer.zombie.tier2']);
    expect(pre('slayer.wolf.tier1')).toEqual(['slayer.spider.tier2']);
    expect(pre('slayer.enderman.tier1')).toEqual(['slayer.wolf.tier4']);
    expect(pre('slayer.blaze.tier1')).toEqual(['slayer.enderman.tier3']);
    expect(pre('slayer.vampire.tier1')).toEqual(['slayer.wolf.tier2']);
    expect(pre('slayer.zombie.tier2')).toEqual(['slayer.zombie.tier1', 'skills.combat.level5']);
    expect(pre('slayer.zombie.tier5')).toEqual(['slayer.zombie.tier4', 'skills.combat.level25', 'slayer.zombie.level7']);
    expect(pre('slayer.vampire.tier5')).toEqual(['slayer.vampire.tier4']); // Rift requirements not modelled
  });

  it('gates dungeon floors on Combat 15 and Catacombs level', () => {
    expect(pre('catacombs.floor0')).toEqual(['skills.combat.level15']);
    expect(pre('catacombs.floor1')).toEqual(['catacombs.floor0', 'catacombs.level1']);
    expect(pre('catacombs.floor7')).toEqual(['catacombs.floor6', 'catacombs.level24']);
    expect(pre('catacombs.master1')).toEqual(['catacombs.floor7', 'catacombs.level24']);
    expect(pre('catacombs.master7')).toEqual(['catacombs.master6', 'catacombs.level36']);
  });
});
