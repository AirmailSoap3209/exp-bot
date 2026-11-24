import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProfilesResponse, RawProfile } from '../../src/hypixel/client.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import { SLAYER_BOSSES, type NormalizedProfile, type Section } from '../../src/profile/types.js';

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;

const skillsResource = fixture<SkillsResource>('resource-skills.json');
const players = ['floor7sweat', 'ducksterr_', 'dik9'].map((f) =>
  fixture<{ uuid: string; name: string; response: ProfilesResponse }>(`profiles-${f}.json`),
);

function load(player: string, cuteName: string): { raw: RawProfile; n: NormalizedProfile } {
  const p = players.find((x) => x.name.toLowerCase() === player.toLowerCase())!;
  const raw = pickProfile(p.response.profiles, cuteName)!;
  return { raw, n: normalizeProfile(raw, p.uuid, skillsResource, 0) };
}

function value<T>(s: Section<T>): T {
  if (!s.available) throw new Error(`expected section to be available, got: ${s.reason}`);
  return s.value;
}

const all = players.flatMap((p) => (p.response.profiles ?? []).map((raw) => ({ p, raw })));

describe('normalizeProfile on real fixtures', () => {
  it('reads a full solo-ish profile (Lime)', () => {
    const { n } = load('Floor7Sweat', 'lime');
    expect(n.leveling).toMatchObject({ experience: 20878, level: 208 });
    expect(value(n.leveling.completedTasks).has('COMPLETE_CATACOMBS7')).toBe(true);

    const coll = value(n.collections.amounts);
    // The other member left the co-op, so only this player's collection counts.
    expect(coll).toMatchObject({ activeMembers: 1, hiddenMembers: 0 });
    expect(coll.byItem.WHEAT).toBe(3364753);
    expect(value(n.collections.unlockedTiers).has('GRAVEL_2')).toBe(true);

    expect(value(n.bestiary).kills.graveyard_zombie_1).toBe(558);
    expect(value(n.bestiary).kills).not.toHaveProperty('last_killed_mob');
    expect(value(n.bestiary).lastClaimedMilestone).toBe(154);

    expect(value(n.slayer).zombie).toMatchObject({ xp: 104305, level: 7, claimedLevel: 7, bossKills: [1, 2, 1, 163, 2] });

    const cata = value(n.catacombs);
    expect(cata.floorCompletions).toEqual({ 0: 5, 1: 9, 2: 3, 3: 21, 4: 14, 5: 43, 6: 46, 7: 53 });
    expect(cata.masterCompletions['3']).toBe(69);
    expect(cata.masterCompletions).not.toHaveProperty('total');

    expect(value(n.fairySouls)).toEqual({ collected: 198, exchanges: 37 });
    expect(value(n.minions).crafted.has('SNOW_1')).toBe(true);
    expect(value(n.skills).foraging).toMatchObject({ maxLevel: 53, capSource: 'profile' });
    expect(value(n.skills).farming).toMatchObject({ maxLevel: 50, capSource: 'profile' });
  });

  it('sums collections across active co-op members only (Raspberry)', () => {
    const { raw, n } = load('ducksterr_', 'raspberry');
    const coll = value(n.collections.amounts);
    expect(coll).toMatchObject({ activeMembers: 2, hiddenMembers: 0 });
    const active = Object.values(raw.members).filter((m) => !(m.profile as { deletion_notice?: unknown })?.deletion_notice);
    const expected = active.reduce((s, m) => s + ((m.collection as Record<string, number>)?.WHEAT ?? 0), 0);
    expect(coll.byItem.WHEAT).toBe(expected);
    expect(expected).toBeGreaterThan(2876756); // more than this player's own share
  });

  it('marks hidden or absent data unavailable instead of zero (Pineapple)', () => {
    const { raw, n } = load('Floor7Sweat', 'pineapple');
    // Own collections hidden => unavailable, even though co-op mates' collections are visible.
    expect(Object.values(raw.members).some((m) => m.collection)).toBe(true);
    expect(n.collections.amounts).toEqual({ available: false, reason: 'Collections API is off' });
    // Tiers stay visible with the Collections API off.
    expect(value(n.collections.unlockedTiers).size).toBe(825);
    for (const s of [n.bestiary, n.slayer, n.catacombs, n.fairySouls, n.minions]) expect(s.available).toBe(false);
    expect(n.skills.available).toBe(true);
  });

  it('treats an empty skills object as unknown, but zero SkyBlock XP as an empty task list (Apple)', () => {
    const { n } = load('Floor7Sweat', 'apple');
    expect(n.gameMode).toBe('ironman');
    expect(n.skills.available).toBe(false);
    expect(value(n.leveling.completedTasks).size).toBe(0);
    expect(value(n.bestiary).kills).toEqual({});
  });

  it('reads a bingo profile (Peach)', () => {
    const { n } = load('dik9', 'peach');
    // No unlocked tiers either, so it can't claim the API is off.
    expect(n.collections.amounts).toEqual({ available: false, reason: 'No collection data (Collections API off, or nothing collected yet)' });
    expect(n).toMatchObject({ gameMode: 'bingo', selected: true, leveling: { experience: 123, level: 1 } });
    expect(value(n.leveling.completedTasks)).toEqual(new Set(['PERSONAL_BANK_THREE', 'PERSONAL_BANK_ONE', 'PERSONAL_BANK_TWO', 'ABIPHONE_slayer']));
    expect(n.skills.available).toBe(false);
  });

  it('computes slayer levels that match the levels claimed in-game, on every fixture', () => {
    let checked = 0;
    for (const { p, raw } of all) {
      const s = normalizeProfile(raw, p.uuid, skillsResource, 0).slayer;
      if (!s.available) continue;
      for (const boss of SLAYER_BOSSES) {
        expect(s.value[boss].level, `${p.name}/${raw.cute_name}/${boss}`).toBe(s.value[boss].claimedLevel);
        checked++;
      }
    }
    expect(checked).toBe(18);
  });

  it('places every skill level between its XP thresholds', () => {
    for (const { p, raw } of all) {
      const s = normalizeProfile(raw, p.uuid, skillsResource, 0).skills;
      if (!s.available) continue;
      for (const [skill, prog] of Object.entries(s.value)) {
        const levels = skillsResource.skills[skill.toUpperCase()]!.levels.map((l) => l.totalExpRequired);
        if (prog.level > 0) expect(prog.xp).toBeGreaterThanOrEqual(levels[prog.level - 1]!);
        if (prog.level < prog.maxLevel) expect(prog.xp).toBeLessThan(levels[prog.level]!);
      }
    }
  });
});

describe('pickProfile', () => {
  const profiles = players[0]!.response.profiles;
  it('defaults to the selected profile', () => expect(pickProfile(profiles)?.cute_name).toBe('Lime'));
  it('matches cute name case-insensitively and profile ID', () => {
    expect(pickProfile(profiles, 'APPLE')?.cute_name).toBe('Apple');
    expect(pickProfile(profiles, 'd80cf12f-035f-412b-bc88-3995fccafdfc')?.cute_name).toBe('Pineapple');
  });
  it('returns undefined for an unknown name', () => expect(pickProfile(profiles, 'Banana')).toBeUndefined());
});
