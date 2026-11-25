/**
 * Reads each grindable bestiary family's page on hypixelskyblock.minecraft.wiki and saves what one
 * kill gives, for generated mob combos: Combat XP (and any other skill XP) from the Mob Drops Table,
 * and the drops at 100% chance, mapped to collection item IDs.
 *
 *   npx tsx scripts/fetch-wiki-mobs.ts
 *
 * Writes data/sources/wiki-mobs.json. Then run npm run catalogue:build.
 */
import { readFileSync, writeFileSync } from 'node:fs';

type Range = [number, number];
interface Family { id: string; name: string; island: string }
interface MobEntry { page: string; combatXp: Range; otherXp?: Record<string, Range>; drops: Record<string, Range> }

/** Islands whose mobs are farmed by walking around and killing them (not bosses, events, sea creatures, dungeons or Kuudra). */
const GRIND_ISLANDS = new Set(['dynamic', 'hub', 'farming_1', 'combat_1', 'combat_3', 'crimson_isle', 'mining_2', 'mining_3', 'crystal_hollows', 'foraging_1', 'foraging_2', 'foraging_3']);
/** Bosses and one-off mobs on those islands. */
const SKIP = new Set(['combat_1.arachne', 'combat_1.broodmother', 'combat_3.dragon', 'combat_3.end_stone_protector', 'crimson_isle.ashfang', 'crimson_isle.barbarian_duke_x',
  'crimson_isle.bladesoul', 'crimson_isle.mage_outlaw', 'crimson_isle.magma_boss', 'crystal_hollows.bal', 'crystal_hollows.boss_corleone', 'crystal_hollows.key_guardian', 'foraging_1.soul_of_the_alpha']);
/** Wiki page names that differ from the bestiary name. */
const PAGE: Record<string, string> = { 'dynamic.enderman': 'Enderman', 'combat_3.enderman': 'Enderman', 'hub.wolf': 'Wolf', 'dynamic.bat': 'Bat' };

const families = JSON.parse(readFileSync('data/bestiary/families.json', 'utf8')) as Family[];
const rated = new Set((JSON.parse(readFileSync('data/rates/bestiary.json', 'utf8')) as { activity: string }[]).map((r) => r.activity));
const collections = JSON.parse(readFileSync('data/sources/hypixel-collections.json', 'utf8')).collections as Record<string, { items: Record<string, { name: string }> }>;
const itemByName = new Map<string, string>();
for (const cat of Object.values(collections)) for (const [id, item] of Object.entries(cat.items)) itemByName.set(item.name.toLowerCase(), id);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function raw(title: string, hops = 2): Promise<{ title: string; text: string } | undefined> {
  const res = await fetch(`https://hypixelskyblock.minecraft.wiki/w/${encodeURIComponent(title.replace(/ /g, '_'))}?action=raw`, { headers: { 'User-Agent': 'exp-bot wiki reader' } });
  if (!res.ok) return undefined;
  const text = await res.text();
  const redirect = /^#REDIRECT \[\[([^\]#|]+)/i.exec(text);
  if (redirect && hops > 0) return raw(redirect[1]!, hops - 1);
  return { title, text };
}

const num = (s: string) => Number(s.replace(/[,\s]/g, ''));
const span = (xs: number[]): Range => [Math.min(...xs), Math.max(...xs)];

/** Every Mob Drops Table on the page (one per level or variant). */
function parse(text: string) {
  const tables = text.split('{{Mob Drops Table').slice(1);
  const xp: Record<string, number[]> = {};
  const drops: Record<string, number[]> = {};
  let tablesWithDrop = 0;
  for (const t of tables) {
    const head = t.split('{{Mob Drops Row')[0]!;
    for (const m of head.matchAll(/\|\s*(\w+)_xp\s*=\s*([\d,.]+)/g)) (xp[m[1]!] ??= []).push(num(m[2]!));
    const seen = new Set<string>();
    for (const row of t.split('{{Mob Drops Row').slice(1)) {
      const drop = /\|\s*drop\s*=\s*([^\n|]+)/.exec(row)?.[1]?.trim();
      const chance = /\|\s*chance\s*=\s*([^\n|]+)/.exec(row)?.[1]?.trim();
      const count = /\|\s*count\s*=\s*([^\n|]+)/.exec(row)?.[1]?.trim() ?? '1';
      if (!drop || chance !== '100%') continue;
      const id = itemByName.get(drop.toLowerCase());
      if (!id) continue;
      const [lo, hi] = count.split(/\s*[-–]\s*/).map(num);
      if (!(lo! > 0)) continue;
      (drops[id] ??= []).push(lo!, hi ?? lo!);
      seen.add(id);
    }
    if (seen.size) tablesWithDrop++;
  }
  return { xp, drops, tables: tables.length, tablesWithDrop };
}

const out: Record<string, MobEntry> = {};
const missing: string[] = [];
for (const f of families) {
  const island = f.id.split('.')[0]!;
  if (!GRIND_ISLANDS.has(island) || SKIP.has(f.id) || !rated.has(`combat.${f.id}`)) continue;
  const page = await raw(PAGE[f.id] ?? f.name);
  await sleep(250);
  const p = page && parse(page.text);
  if (!p || !p.xp.combat?.length) { missing.push(`${f.id} (${f.name})`); continue; }
  // A drop counts only if every variant's table has it at 100%; otherwise it's not guaranteed per kill.
  const drops = Object.fromEntries(Object.entries(p.drops).filter(([, v]) => v.length / 2 >= p.tablesWithDrop && p.tablesWithDrop === p.tables).map(([k, v]) => [k, span(v)]));
  const otherXp = Object.fromEntries(Object.entries(p.xp).filter(([k]) => k !== 'combat').map(([k, v]) => [k, span(v)]));
  out[f.id] = { page: page.title, combatXp: span(p.xp.combat), ...(Object.keys(otherXp).length ? { otherXp } : {}), drops };
  console.log(f.id.padEnd(36), out[f.id]!.combatXp.join('-').padEnd(10), Object.entries(drops).map(([k, v]) => `${k} ${v.join('-')}`).join(', '));
}
writeFileSync('data/sources/wiki-mobs.json', JSON.stringify({
  source: `hypixelskyblock.minecraft.wiki mob pages, Mob Drops Table (raw wikitext), fetched ${new Date().toISOString().slice(0, 10)} by scripts/fetch-wiki-mobs.ts`,
  note: 'Per kill: Combat XP (and other skill XP) across the page\'s level variants, and drops at 100% chance in every variant, mapped to collection item IDs. Wisdom and Looting add more, so these are floors.',
  families: out,
  noData: missing,
}, null, 1) + '\n');
console.log(`\n${Object.keys(out).length} families saved; no Mob Drops Table for ${missing.length}: ${missing.join(', ')}`);
