export const TRACKING = ['api', 'manual', 'none'] as const;
export type Tracking = (typeof TRACKING)[number];

export const CATEGORY_STATUS = ['v1', 'later', 'never'] as const;
export type CategoryStatus = (typeof CATEGORY_STATUS)[number];

/** One SkyBlock XP source. Tiered sources have one task per tier. */
export interface Task {
  id: string;
  category: string;
  name: string;
  description: string;
  /** SkyBlock XP awarded for this task alone. */
  xp: number;
  /** A metric the category's progress reader produces, and the amount needed. */
  requires: { metric: string; amount: number };
  prerequisites: string[];
  /** Links to a rate in data/rates/. Null for fixed-time tasks. */
  activity: string | null;
  location?: string;
  monetary: boolean;
  tracking: Tracking;
  /** Where the XP value and requirement came from, and when. */
  source: string;
  /** Tiered sources: tasks sharing a group are tiers of one source. */
  group?: string;
  tier?: number;
  /** Hypixel's ID in leveling.completed_tasks, when the game reports this task directly. */
  hypixelTaskId?: string;
  /** Fixed time range for tasks that don't depend on gear. */
  minutes?: [number, number];
  /** Where the task can be done and what it takes to get there (data/sources/access.json). */
  access?: Access;
}

/** One place a task can be done, and what reaching it needs. */
export interface AccessArea {
  id: string;
  name: string;
  /** Skill levels, checked against the profile. */
  skills?: Record<string, number>;
  /** SkyBlock level, checked against the profile. */
  sbLevel?: number;
  /** Requirements the API doesn't show (HOTM tiers, quests, keys); met only when the profile shows progress in the area. */
  other?: string[];
}

export interface Access {
  /** Any one of these areas is enough. */
  anyOf: AccessArea[];
  /** Needed wherever the task is done, e.g. a sea creature's Fishing level. */
  skills?: Record<string, number>;
  /** Needed wherever the task is done and not in the API data. */
  other?: string[];
}

export interface CategoryMeta {
  id: string;
  name: string;
  status: CategoryStatus;
  /** In-game SkyBlock Guide category this belongs to. */
  guide: string;
  /** Max XP the wiki lists for this category, to sanity-check the catalogue. */
  wikiMaxXp?: number;
  /** Left out of overview and rankings unless the user runs /xp include. */
  defaultExcluded?: boolean;
  note?: string;
}

export interface GuideCategory {
  id: string;
  name: string;
  /** Max XP shown in-game. Null until checked. */
  maxXp: number | null;
  /** Rough wiki-derived total, shown with "~" while maxXp is unknown. */
  wikiEstimate: number | null;
}

export interface Meta {
  checked: string;
  note?: string;
  guideCategories: GuideCategory[];
  categories: CategoryMeta[];
}
