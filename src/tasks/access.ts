import type { NormalizedProfile, SkillId } from '../profile/types.js';
import type { TaskProgress } from './progress.js';
import type { AccessArea } from './types.js';

const title = (s: string) => s[0]!.toUpperCase() + s.slice(1);

const isDone = (p: TaskProgress) => p.status === 'verified_complete' || p.status === 'ticked' || p.likelyComplete;
/** Shows real progress: done, or any amount counted toward it. */
const hasProgress = (p: TaskProgress) => isDone(p) || (p.current ?? 0) > 0;

/** Unmet skill requirements, as text; unknown skill data counts as unmet. */
function unmetSkills(skills: Record<string, number> | undefined, profile: NormalizedProfile): string[] {
  if (!skills) return [];
  const known = profile.skills.available ? profile.skills.value : undefined;
  return Object.entries(skills)
    .filter(([s, lv]) => !known || (known[s as SkillId]?.level ?? 0) < lv)
    .map(([s, lv]) => `${title(s)} ${lv}${known ? '' : ' (no skill data to check)'}`);
}

/**
 * The player's Heart of the Mountain tier, read off the hotm.tiers tasks (their thresholds are
 * the wiki's HOTM XP table); undefined when the profile has no HOTM data.
 */
function hotmTier(progress: TaskProgress[], profile: NormalizedProfile): number | undefined {
  if (!profile.skillTree.available) return undefined;
  let tier = 0;
  for (const p of progress) {
    if (p.task.group === 'hotm.tiers' && p.status === 'verified_complete') tier = Math.max(tier, p.task.tier ?? 0);
  }
  return tier;
}

interface Unmet {
  /** Waived once the area or the task shows progress (skills, SkyBlock level, unchecked requirements). */
  soft: string[];
  /** The player's own unlocks, checked in the API: they hold even then (co-op collections count others' progress). */
  hard: string[];
}

/** What still stands between the player and an area. */
function unmetArea(a: AccessArea, profile: NormalizedProfile, proven: ReadonlySet<string>, hotmTier: () => number | undefined): Unmet {
  const hard: string[] = [];
  if (a.hotm) {
    const hotm = hotmTier();
    if ((hotm ?? 0) < a.hotm) hard.push(`Heart of the Mountain ${a.hotm}${hotm === undefined ? ' (no HOTM data to check)' : ''}`);
  }
  if (proven.has(a.id)) return { soft: [], hard };
  const soft = unmetSkills(a.skills, profile);
  if (a.sbLevel && profile.leveling.level < a.sbLevel) soft.push(`SkyBlock level ${a.sbLevel}`);
  // Not in the API data: only progress already made there proves these.
  if (a.other?.length) soft.push(unchecked(a.other));
  return { soft, hard };
}

const unchecked = (list: string[]) => `${list.join(' and ')} (not shown in the API)`;

/**
 * Marks tasks blocked when the player can't reach where they're done yet
 * (data/sources/access.json, from the wiki). An area counts as reachable when its
 * requirements are met, or when any task done only there already shows progress.
 * A task with progress of its own isn't blocked, except by a Heart of the Mountain tier:
 * that is checked in the API and is the player's own, so co-op progress doesn't waive it.
 * Done tasks are never blocked. Returns the same list, with `blocked` set on newly blocked tasks.
 */
export function applyAccess(progress: TaskProgress[], profile: NormalizedProfile): TaskProgress[] {
  const proven = new Set<string>();
  for (const p of progress) {
    const areas = p.task.access?.anyOf;
    if (areas?.length === 1 && hasProgress(p)) proven.add(areas[0]!.id);
  }
  let tier: { v: number | undefined } | undefined;
  const hotm = () => (tier ??= { v: hotmTier(progress, profile) }).v;
  return progress.map((p) => {
    const a = p.task.access;
    if (!a || p.blocked || p.status === 'unavailable' || isDone(p)) return p;
    const own = hasProgress(p);
    const missing: string[] = [];
    if (a.anyOf.length) {
      const perArea = a.anyOf.map((area) => {
        const u = unmetArea(area, profile, proven, hotm);
        return own ? u.hard : [...u.hard, ...u.soft];
      });
      if (perArea.every((m) => m.length)) {
        const names = a.anyOf.map((x) => x.name).join(' or ');
        missing.push(a.anyOf.length === 1 ? `${names} access: ${perArea[0]!.join(', ')}` : `access to ${names}`);
      }
    }
    if (!own) {
      missing.push(...unmetSkills(a.skills, profile));
      if (a.other?.length) missing.push(unchecked(a.other));
    }
    return missing.length ? { ...p, blocked: `Needs ${missing.join('; ')}` } : p;
  });
}
