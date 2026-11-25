import type { Reader } from '../progress.js';
import { bestiary } from './bestiary.js';
import { catacombs } from './catacombs.js';
import { collections } from './collections.js';
import { fairySouls } from './fairySouls.js';
import { foragingTasks, garden, hotm, mythological, rift, trophyFishing } from './leveling.js';
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
  // SkyBlock Leveling groups (data/sources/leveling-tasks.json). Categories whose tasks are all
  // task.<ID> metrics (dragons, kuudra, events, ...) need no reader: the completed-task list decides.
  hotm,
  foraging_tasks: foragingTasks,
  garden,
  trophy_fishing: trophyFishing,
  rift,
  mythological,
};

export function readerFor(category: string): Reader | undefined {
  return READERS[category];
}
