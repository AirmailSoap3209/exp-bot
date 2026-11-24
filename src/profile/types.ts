/**
 * Normalized progress for one member of one SkyBlock profile.
 *
 * Every section is wrapped in `Section<T>`: when the API did not send the data
 * (setting off, never played it, not exposed) the section is unavailable with a
 * reason. Readers must never turn an unavailable section into zero progress.
 */
export type Section<T> = { available: true; value: T } | { available: false; reason: string };

export const SKILLS = [
  'farming', 'mining', 'combat', 'foraging', 'fishing', 'enchanting',
  'alchemy', 'carpentry', 'runecrafting', 'social', 'taming', 'hunting',
] as const;
export type SkillId = (typeof SKILLS)[number];

export const SLAYER_BOSSES = ['zombie', 'spider', 'wolf', 'enderman', 'blaze', 'vampire'] as const;
export type SlayerBoss = (typeof SLAYER_BOSSES)[number];

export const DUNGEON_CLASSES = ['healer', 'mage', 'berserk', 'archer', 'tank'] as const;
export type DungeonClass = (typeof DUNGEON_CLASSES)[number];

export interface LeveledXp {
  xp: number;
  level: number;
  /** Level the player can currently reach (skill caps), or the table maximum. */
  maxLevel: number;
}

export interface SkillProgress extends LeveledXp {
  /** Where maxLevel came from: a cap field on the profile, or just the resource table. */
  capSource: 'profile' | 'resource';
}

export interface SlayerProgress extends LeveledXp {
  /** Highest level reward claimed in-game (claimed_levels). */
  claimedLevel: number;
  /** Boss kills indexed by tier (0 = tier I). */
  bossKills: number[];
}

export interface CatacombsProgress {
  level: LeveledXp;
  classes: Record<DungeonClass, LeveledXp>;
  /** Normal floor completions, keyed by floor ("0" = Entrance). */
  floorCompletions: Record<string, number>;
  /** Master Mode completions, keyed by floor. */
  masterCompletions: Record<string, number>;
}

export interface CollectionAmounts {
  /** Collection amount per item ID, summed over visible co-op members. */
  byItem: Record<string, number>;
  /** Active co-op members (including this player). */
  activeMembers: number;
  /** Active members whose collections are hidden; their share is missing from byItem. */
  hiddenMembers: number;
  /** This player's own share, for measuring their own gathering rate. */
  ownByItem: Record<string, number>;
}

export interface NormalizedProfile {
  uuid: string;
  profileId: string;
  cuteName: string;
  selected: boolean;
  gameMode: string;
  /** Epoch ms the underlying API data was fetched. */
  fetchedAt: number;

  leveling: {
    experience: number;
    level: number;
    /** Hypixel's own completed SkyBlock XP task IDs (one-time tasks only). */
    completedTasks: Section<Set<string>>;
  };
  skills: Section<Record<SkillId, SkillProgress>>;
  collections: {
    /** Unlocked tier keys like "WHEAT_5". Visible even with the Collections API off. */
    unlockedTiers: Section<Set<string>>;
    amounts: Section<CollectionAmounts>;
  };
  bestiary: Section<{
    /** Kills per bestiary mob key, e.g. "graveyard_zombie_1". */
    kills: Record<string, number>;
    lastClaimedMilestone: number;
  }>;
  slayer: Section<Record<SlayerBoss, SlayerProgress>>;
  catacombs: Section<CatacombsProgress>;
  fairySouls: Section<{ collected: number; exchanges: number }>;
  minions: Section<{ crafted: Set<string> }>;
}
