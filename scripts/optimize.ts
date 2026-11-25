/**
 * Prints the /xp optimize ranking for a saved fixture, without Discord or the API.
 *
 *   npm run optimize -- <fixture player name> [profile name] [--limit N]
 */
import { readFileSync } from 'node:fs';
import { formatEntry } from '../src/commands/optimize.js';
import { loadRates } from '../src/estimate/rates.js';
import type { ProfilesResponse } from '../src/hypixel/client.js';
import { rankWithCombos } from '../src/optimizer/combined.js';
import { loadCombos } from '../src/combos/combos.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../src/profile/normalize.js';
import { defaultExcluded, loadCatalogue } from '../src/tasks/catalogue.js';
import { evaluateProgress } from '../src/tasks/progress.js';

const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const limit = li >= 0 ? Number(args.splice(li, 2)[1]) : 10;
const [player, profileName] = args;
if (!player) {
  console.error('Usage: npm run optimize -- <fixture player name> [profile name] [--limit N]');
  process.exit(1);
}
const read = <T>(f: string) => JSON.parse(readFileSync(`test/fixtures/${f}`, 'utf8')) as T;
const { uuid, name, response } = read<{ uuid: string; name: string; response: ProfilesResponse }>(`profiles-${player.toLowerCase()}.json`);
const raw = pickProfile(response.profiles, profileName);
if (!raw) throw new Error(`No profile ${profileName ?? '(selected)'} for ${name}`);
const profile = normalizeProfile(raw, uuid, read<SkillsResource>('resource-skills.json'), Date.now());
const catalogue = loadCatalogue();
const { progress } = evaluateProgress(catalogue, profile);
const book = loadRates();
const result = rankWithCombos(progress, profile, { book }, loadCombos(catalogue, book), { limit, excluded: new Set(defaultExcluded(catalogue)) });

console.log(`${name} / ${profile.cuteName}\n`);
console.log(result.ranked.map((r, i) => formatEntry(i + 1, r).replace(/\*\*/g, '')).join('\n\n'));
console.log('\ndropped:', JSON.stringify(result.dropped));
