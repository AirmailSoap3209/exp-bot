/**
 * Refreshes the inputs the catalogue is generated from, into data/sources/.
 *
 *   npm run catalogue:sources
 *
 * - Hypixel public resources (skills, collections): live, no key needed.
 * - NotEnoughUpdates-REPO constants, pinned to NEU_COMMIT so rebuilds are reproducible.
 *   Bump the commit deliberately after a SkyBlock update, then rebuild and review the diff.
 *
 * wiki-xp.json and bestiary-overrides.json are hand-maintained and not touched here.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { hypixel } from '../src/hypixel/index.js';

const NEU_COMMIT = 'aaaea3338b51832cbbd315414567eddef9f924dc'; // 2026-11-22
const NEU_RAW = `https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/${NEU_COMMIT}/constants`;
const OUT = 'data/sources';

interface NeuMob { name: string; cap: number; mobs: string[]; bracket: number }
interface NeuIsland { name: string; mobs?: NeuMob[]; hasSubcategories?: boolean; [k: string]: unknown }

async function neu<T>(file: string): Promise<T> {
  const res = await fetch(`${NEU_RAW}/${file}`);
  if (!res.ok) throw new Error(`NEU ${file}: ${res.status}`);
  return (await res.json()) as T;
}

const stripColour = (s: string) => s.replace(/§./g, '').trim();

async function main() {
  await mkdir(OUT, { recursive: true });
  const fetchedAt = new Date().toISOString().slice(0, 10);

  const skills = await hypixel.getSkillsResource();
  const collections = await hypixel.getCollectionsResource();
  await writeFile(`${OUT}/hypixel-skills.json`, JSON.stringify({ fetchedAt, ...(skills.data as object) }, null, 1));
  await writeFile(`${OUT}/hypixel-collections.json`, JSON.stringify({ fetchedAt, ...(collections.data as object) }, null, 1));

  // Bestiary: flatten islands (and fishing subcategories), drop textures.
  const raw = await neu<Record<string, unknown>>('bestiary.json');
  const families: { island: string; islandName: string; name: string; cap: number; mobs: string[]; bracket: number }[] = [];
  const addIsland = (key: string, island: NeuIsland) => {
    for (const m of island.mobs ?? []) {
      families.push({ island: key, islandName: stripColour(island.name), name: stripColour(m.name), cap: m.cap, mobs: m.mobs, bracket: m.bracket });
    }
  };
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'brackets' || key === 'bracketSets' || typeof value !== 'object' || value === null) continue;
    const island = value as NeuIsland;
    if (island.hasSubcategories) {
      for (const [sub, subValue] of Object.entries(island)) {
        if (typeof subValue === 'object' && subValue !== null && Array.isArray((subValue as NeuIsland).mobs)) {
          addIsland(`${key}.${sub}`, subValue as NeuIsland);
        }
      }
    } else addIsland(key, island);
  }
  await writeFile(
    `${OUT}/neu-bestiary.json`,
    JSON.stringify({ source: `NEU-REPO constants/bestiary.json @ ${NEU_COMMIT}`, fetchedAt, brackets: raw.brackets, families }, null, 1),
  );

  const misc = await neu<{ minions: Record<string, number> }>('misc.json');
  await writeFile(
    `${OUT}/neu-minions.json`,
    JSON.stringify({ source: `NEU-REPO constants/misc.json (minions) @ ${NEU_COMMIT}`, fetchedAt, maxTiers: misc.minions }, null, 1),
  );

  console.log(`Wrote ${OUT}: hypixel-skills, hypixel-collections, neu-bestiary (${families.length} families), neu-minions (${Object.keys(misc.minions).length})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
