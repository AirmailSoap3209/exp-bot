/**
 * Prints the /xp target plan for a saved fixture, without Discord or the API.
 *
 *   npm run target -- <fixture player name> [profile name] (--xp N | --level N)
 */
import { readFileSync } from 'node:fs';
import { targetLines } from '../src/commands/targetPlan.js';
import { formatMinutes } from '../src/commands/optimize.js';
import { loadRates } from '../src/estimate/rates.js';
import type { ProfilesResponse } from '../src/hypixel/client.js';
import { planTarget, xpToLevel } from '../src/optimizer/target.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../src/profile/normalize.js';
import { defaultExcluded, loadCatalogue } from '../src/tasks/catalogue.js';
import { evaluateProgress } from '../src/tasks/progress.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args.splice(i, 2)[1]) : undefined;
};
const xpArg = flag('--xp');
const levelArg = flag('--level');
const [player, profileName] = args;
if (!player || (xpArg === undefined) === (levelArg === undefined)) {
  console.error('Usage: npm run target -- <fixture player name> [profile name] (--xp N | --level N)');
  process.exit(1);
}
const read = <T>(f: string) => JSON.parse(readFileSync(`test/fixtures/${f}`, 'utf8')) as T;
const { uuid, name, response } = read<{ uuid: string; name: string; response: ProfilesResponse }>(`profiles-${player.toLowerCase()}.json`);
const raw = pickProfile(response.profiles, profileName);
if (!raw) throw new Error(`No profile ${profileName ?? '(selected)'} for ${name}`);
const profile = normalizeProfile(raw, uuid, read<SkillsResource>('resource-skills.json'), Date.now());
const catalogue = loadCatalogue();
const { progress } = evaluateProgress(catalogue, profile);
const target = xpArg ?? xpToLevel(levelArg!, profile.leveling.experience);
if (target <= 0) {
  console.log(`Already level ${profile.leveling.level}.`);
  process.exit(0);
}

const t0 = performance.now();
const plan = planTarget(progress, profile, { book: loadRates() }, target, { excluded: new Set(defaultExcluded(catalogue)) });
const ms = performance.now() - t0;

console.log(`${name} / ${profile.cuteName} · target +${target} XP · level ${profile.leveling.level}`);
console.log(`plan: ${plan.xp} XP · ${formatMinutes(plan.minutes)} · ${plan.picks.length} steps · trimmed ${plan.trimmed} · reached ${plan.reached} · capped ${plan.capped} · ${ms.toFixed(0)} ms\n`);
console.log(targetLines(plan).map((l) => l.replace(/\*\*/g, '')).join('\n'));
