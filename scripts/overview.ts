/**
 * Prints the /xp overview numbers for a saved fixture, without Discord or the API.
 *
 *   npm run overview -- <fixture player name> [profile name]
 */
import { readFileSync } from 'node:fs';
import type { ProfilesResponse } from '../src/hypixel/client.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../src/profile/normalize.js';
import { loadCatalogue } from '../src/tasks/catalogue.js';
import { evaluateProgress, STATUS_LABEL, STATUSES, summarize } from '../src/tasks/progress.js';

const [player, profileName] = process.argv.slice(2);
if (!player) {
  console.error('Usage: npm run overview -- <fixture player name> [profile name]');
  process.exit(1);
}
const read = <T>(f: string) => JSON.parse(readFileSync(`test/fixtures/${f}`, 'utf8')) as T;
const { uuid, name, response } = read<{ uuid: string; name: string; response: ProfilesResponse }>(`profiles-${player.toLowerCase()}.json`);
const raw = pickProfile(response.profiles, profileName);
if (!raw) throw new Error(`No profile ${profileName ?? '(selected)'} for ${name}`);
const profile = normalizeProfile(raw, uuid, read<SkillsResource>('resource-skills.json'), Date.now());
const catalogue = loadCatalogue();
const s = summarize(evaluateProgress(catalogue, profile).progress);
const fmt = (n: number) => n.toLocaleString('en-US');

console.log(`${name} / ${profile.cuteName}: level ${profile.leveling.level} (${fmt(profile.leveling.experience)} XP)`);
console.log(`earned ${fmt(s.earned)} · remaining ${fmt(s.remaining)} · est. done ${fmt(s.likelyComplete)} · unknown ${fmt(s.unknown)}`);
console.log(STATUSES.map((st) => `${STATUS_LABEL[st]} ${s.counts[st]}`).join(' · '));
for (const [cat, b] of s.byCategory) {
  const reasons = [...b.unavailableReasons].join('; ');
  console.log(`  ${cat.padEnd(12)} earned ${fmt(b.earned).padStart(6)}  left ${fmt(b.remaining).padStart(6)}  est.done ${fmt(b.likelyComplete).padStart(5)}  unknown ${fmt(b.unknown).padStart(6)}${reasons ? `  (${reasons})` : ''}`);
}
