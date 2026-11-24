/**
 * Build step 1 "Check first": fetch real profiles, report which fields exist,
 * and save the raw responses as test fixtures.
 *
 *   npm run check-api -- <username> [username ...]
 *
 * Use a mix: your own account, and ideally one player with collections / skills API off.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { hypixel, type RawProfile } from '../src/hypixel/index.js';

const FIXTURES = 'test/fixtures';

/** Fields the v1 readers expect, with the API setting that hides them (if any). */
const PROBES: { path: string; category: string; setting?: string }[] = [
  { path: 'leveling', category: 'leveling' },
  { path: 'leveling.experience', category: 'leveling' },
  { path: 'leveling.completed_tasks', category: 'leveling' },
  { path: 'leveling.completions', category: 'leveling' },
  { path: 'player_data.experience', category: 'skills', setting: 'Skills API' },
  { path: 'player_data.unlocked_coll_tiers', category: 'collections' },
  { path: 'player_data.crafted_generators', category: 'minions' },
  { path: 'collection', category: 'collections', setting: 'Collections API' },
  { path: 'bestiary', category: 'bestiary' },
  { path: 'bestiary.kills', category: 'bestiary' },
  { path: 'bestiary.milestone', category: 'bestiary' },
  { path: 'slayer.slayer_bosses', category: 'slayer' },
  { path: 'dungeons.dungeon_types.catacombs.experience', category: 'catacombs' },
  { path: 'dungeons.dungeon_types.catacombs.tier_completions', category: 'catacombs' },
  { path: 'dungeons.dungeon_types.master_catacombs.tier_completions', category: 'catacombs' },
  { path: 'dungeons.player_classes', category: 'catacombs' },
  { path: 'fairy_soul', category: 'fairy souls' },
  { path: 'fairy_soul.total_collected', category: 'fairy souls' },
  { path: 'fairy_soul.fairy_exchanges', category: 'fairy souls' },
  { path: 'inventory', category: '(settings check)', setting: 'Inventory API' },
];

function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

function describe(v: unknown): string {
  if (v === undefined) return 'MISSING';
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return `object(${Object.keys(v).length} keys)`;
  return `${typeof v}: ${String(v)}`;
}

function prefixHistogram(ids: string[]): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const prefix = id.split('_').slice(0, 2).join('_');
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `  ${p}: ${n}`)
    .join('\n');
}

function reportProfile(uuid: string, p: RawProfile): string {
  const member = p.members[uuid];
  const lines: string[] = [];
  const flags = [p.selected ? '[selected]' : '', p.game_mode ? `mode=${p.game_mode}` : ''].filter(Boolean).join(' ');
  lines.push(`### ${p.cute_name ?? '?'} (${p.profile_id}) ${flags}`.trim());
  if (!member) {
    lines.push('Member data not found for this UUID.');
    return lines.join('\n');
  }
  lines.push('', `Member top-level keys: ${Object.keys(member).sort().join(', ')}`, '');
  lines.push('| path | category | value | hidden by |', '|---|---|---|---|');
  for (const probe of PROBES) {
    lines.push(`| ${probe.path} | ${probe.category} | ${describe(at(member, probe.path))} | ${probe.setting ?? ''} |`);
  }
  const tasks = at(member, 'leveling.completed_tasks');
  if (Array.isArray(tasks)) {
    const ids = tasks.map(String);
    lines.push('', `completed_tasks: ${ids.length} IDs. Prefix counts:`, '```', prefixHistogram(ids), '```');
    lines.push('Sample IDs:', '```', ids.slice(0, 40).join('\n'), '```');
  } else {
    lines.push('', 'No leveling.completed_tasks list: "verified complete" must come from per-category readers.');
  }
  return lines.join('\n');
}

async function main() {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error('Usage: npm run check-api -- <username> [username ...]');
    process.exit(1);
  }
  await mkdir(FIXTURES, { recursive: true });

  const sections: string[] = [`# API check — ${new Date().toISOString()}`];

  for (const input of names) {
    const { uuid, name } = await hypixel.resolvePlayer(input);
    const { data } = await hypixel.getProfiles(uuid);
    const file = `${FIXTURES}/profiles-${name.toLowerCase()}.json`;
    await writeFile(file, JSON.stringify({ uuid, name, response: data }, null, 2));
    console.log(`Saved ${file}`);

    sections.push(`## ${name} (${uuid})`);
    if (!data.profiles?.length) {
      sections.push('No SkyBlock profiles.');
      continue;
    }
    for (const p of data.profiles) sections.push(reportProfile(uuid, p));
  }

  const skills = await hypixel.getSkillsResource();
  const collections = await hypixel.getCollectionsResource();
  await writeFile(`${FIXTURES}/resource-skills.json`, JSON.stringify(skills.data, null, 2));
  await writeFile(`${FIXTURES}/resource-collections.json`, JSON.stringify(collections.data, null, 2));

  const s = hypixel.limiter.state;
  sections.push(`## Rate limit after run\n\nlimit=${s.limit ?? '?'} remaining=${s.remaining ?? '?'}`);

  const report = sections.join('\n\n') + '\n';
  await writeFile(`${FIXTURES}/API_CHECK.md`, report);
  console.log('\n' + report);
  console.log(`Report saved to ${FIXTURES}/API_CHECK.md`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
