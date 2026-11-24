/**
 * Prints the normalized profile from a saved fixture, to compare against in-game numbers.
 *
 *   npm run show-profile -- <fixture player name> [profile name]
 */
import { readFileSync } from 'node:fs';
import type { ProfilesResponse } from '../src/hypixel/client.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../src/profile/normalize.js';
import type { Section } from '../src/profile/types.js';

const [player, profileName] = process.argv.slice(2);
if (!player) {
  console.error('Usage: npm run show-profile -- <fixture player name> [profile name]');
  process.exit(1);
}
const read = <T>(f: string) => JSON.parse(readFileSync(`test/fixtures/${f}`, 'utf8')) as T;
const { uuid, name, response } = read<{ uuid: string; name: string; response: ProfilesResponse }>(
  `profiles-${player.toLowerCase()}.json`,
);
const raw = pickProfile(response.profiles, profileName);
if (!raw) throw new Error(`No profile ${profileName ?? '(selected)'} for ${name}`);
const n = normalizeProfile(raw, uuid, read<SkillsResource>('resource-skills.json'), Date.now());

const show = <T>(label: string, s: Section<T>, fmt: (v: T) => string) =>
  console.log(`${label.padEnd(12)} ${s.available ? fmt(s.value) : `UNAVAILABLE (${s.reason})`}`);

console.log(`${name} / ${n.cuteName} (${n.gameMode})`);
console.log(`${'SkyBlock'.padEnd(12)} level ${n.leveling.level} (${n.leveling.experience} XP)`);
show('Tasks', n.leveling.completedTasks, (v) => `${v.size} completed task IDs`);
show('Skills', n.skills, (v) =>
  Object.entries(v).map(([k, s]) => `${k} ${s.level}/${s.maxLevel}`).join(', '));
show('Collections', n.collections.unlockedTiers, (v) => `${v.size} tiers unlocked`);
show('Coll. amts', n.collections.amounts, (v) =>
  `${Object.keys(v.byItem).length} items, ${v.activeMembers} active member(s), ${v.hiddenMembers} hidden`);
show('Bestiary', n.bestiary, (v) => `${Object.keys(v.kills).length} mob keys, milestone ${v.lastClaimedMilestone}`);
show('Slayer', n.slayer, (v) => Object.entries(v).map(([k, s]) => `${k} ${s.level}`).join(', '));
show('Catacombs', n.catacombs, (v) =>
  `level ${v.level.level}; ` + Object.entries(v.classes).map(([k, c]) => `${k} ${c.level}`).join(', '));
show('Fairy souls', n.fairySouls, (v) => `${v.collected} collected, ${v.exchanges} exchanges`);
show('Minions', n.minions, (v) => `${v.crafted.size} unique tiers crafted`);
