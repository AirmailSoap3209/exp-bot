import { readFileSync } from 'node:fs';
import type { LeveledXp, SlayerBoss } from './types.js';

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')) as T;
}

const catacombsTable = loadJson<{ perLevelXp: number[]; overflowPerLevelXp: number }>('data/leveling/catacombs.json');
const slayerTable = loadJson<{ cumulativeXp: Record<SlayerBoss, number[]> }>('data/leveling/slayer.json');

/** Level reached for `xp`, given cumulative XP needed for each level (index 0 = level 1). */
export function levelFromCumulative(xp: number, cumulative: readonly number[], cap = cumulative.length): LeveledXp {
  let level = 0;
  while (level < cap && level < cumulative.length && xp >= cumulative[level]!) level++;
  return { xp, level, maxLevel: cap };
}

const cataCumulative = catacombsTable.perLevelXp.reduce<number[]>((acc, x) => {
  acc.push((acc.at(-1) ?? 0) + x);
  return acc;
}, []);

/**
 * Catacombs and class levels: the table to 50, then a flat amount per level.
 * maxLevel stays at the table maximum (50); `level` can go past it.
 */
export function catacombsLevel(xp: number): LeveledXp {
  const base = levelFromCumulative(xp, cataCumulative);
  if (base.level < cataCumulative.length) return base;
  const overflow = Math.floor((xp - cataCumulative.at(-1)!) / catacombsTable.overflowPerLevelXp);
  return { ...base, level: base.level + overflow };
}

export function slayerLevel(boss: SlayerBoss, xp: number): LeveledXp {
  return levelFromCumulative(xp, slayerTable.cumulativeXp[boss]);
}
