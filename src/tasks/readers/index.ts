import type { Reader } from '../progress.js';
import { bestiary } from './bestiary.js';
import { catacombs } from './catacombs.js';
import { collections } from './collections.js';
import { fairySouls } from './fairySouls.js';
import { minions } from './minions.js';
import { skills } from './skills.js';
import { slayer } from './slayer.js';

/**
 * One reader per catalogue category. Adding an XP source means adding its
 * data/tasks file and a reader here; the status and ranking code stay as they are.
 */
const READERS: Record<string, Reader> = {
  skills,
  collections,
  minions,
  fairy_souls: fairySouls,
  bestiary,
  slayer,
  catacombs,
};

export function readerFor(category: string): Reader | undefined {
  return READERS[category];
}
