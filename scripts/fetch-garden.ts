/**
 * Saves raw Garden responses as test fixtures (test/fixtures/garden-<player>-<profile>.json).
 *
 *   npx tsx scripts/fetch-garden.ts <player> [profile]
 */
import { writeFile } from 'node:fs/promises';
import { hypixel } from '../src/hypixel/index.js';

const [player, profileName] = process.argv.slice(2);
if (!player) throw new Error('usage: fetch-garden <player> [profile]');
const { uuid, name } = await hypixel.resolvePlayer(player);
const profiles = (await hypixel.getProfiles(uuid)).data.profiles ?? [];
for (const p of profiles) {
  if (profileName && p.cute_name?.toLowerCase() !== profileName.toLowerCase()) continue;
  const g = await hypixel.getGarden(p.profile_id);
  const file = `test/fixtures/garden-${name}-${(p.cute_name ?? p.profile_id).toLowerCase()}.json`;
  await writeFile(file, JSON.stringify({ profileId: p.profile_id, response: g.data }, null, 1) + '\n');
  console.log(file, g.data.garden ? Object.keys(g.data.garden).join(', ') : '(no garden)');
}
