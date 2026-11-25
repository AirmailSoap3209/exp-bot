import type { NormalizedProfile, SkillId } from '../profile/types.js';
import type { TaskProgress } from './progress.js';
import type { AccessArea } from './types.js';

const title = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Shows real progress: done, or any amount counted toward it. */
const hasProgress = (p: TaskProgress) =>
  p.status === 'verified_complete' || p.status === 'ticked' || p.likelyComplete || (p.current ?? 0) > 0;

/** Unmet skill requirements, as text; unknown skill data counts as unmet. */
function unmetSkills(skills: Record<string, number> | undefined, profile: NormalizedProfile): string[] {
  if (!skills) return [];
  const known = profile.skills.available ? profile.skills.value : undefined;
  return Object.entries(skills)
    .filter(([s, lv]) => !known || (known[s as SkillId]?.level ?? 0) < lv)
    .map(([s, lv]) => `${title(s)} ${lv}${known ? '' : ' (no skill data to check)'}`);
}

/** What still stands between the player and an area; empty when it's reachable. */
function unmetArea(a: AccessArea, profile: NormalizedProfile, proven: ReadonlySet<string>): string[] {
  if (proven.has(a.id)) return [];
  const out = unmetSkills(a.skills, profile);
  if (a.sbLevel && profile.leveling.level < a.sbLevel) out.push(`SkyBlock level ${a.sbLevel}`);
  // Not in the API data: only progress already made there proves these.
  if (a.other?.length) out.push(unchecked(a.other));
  return out;
}

const unchecked = (list: string[]) => `${list.join(' and ')} (not shown in the API)`;

/**
 * Marks tasks blocked when the player can't reach where they're done yet
 * (data/sources/access.json, from the wiki). An area counts as reachable when its
 * skill and SkyBlock level requirements are met, or when any task done only there
 * already shows progress. A task with progress of its own is never blocked.
 * Returns the same list, with `blocked` set on newly blocked tasks.
 */
export function applyAccess(progress: TaskProgress[], profile: NormalizedProfile): TaskProgress[] {
  const proven = new Set<string>();
  for (const p of progress) {
    const areas = p.task.access?.anyOf;
    if (areas?.length === 1 && hasProgress(p)) proven.add(areas[0]!.id);
  }
  return progress.map((p) => {
    const a = p.task.access;
    if (!a || p.blocked || p.status === 'unavailable' || hasProgress(p)) return p;
    const missing: string[] = [];
    if (a.anyOf.length) {
      const perArea = a.anyOf.map((area) => unmetArea(area, profile, proven));
      if (perArea.every((m) => m.length)) {
        const names = a.anyOf.map((x) => x.name).join(' or ');
        missing.push(a.anyOf.length === 1 ? `${names} access: ${perArea[0]!.join(', ')}` : `access to ${names}`);
      }
    }
    missing.push(...unmetSkills(a.skills, profile));
    if (a.other?.length) missing.push(unchecked(a.other));
    return missing.length ? { ...p, blocked: `Needs ${missing.join('; ')}` } : p;
  });
}
