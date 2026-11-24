import { hypixel } from '../hypixel/index.js';
import { normalizeProfile, pickProfile, type SkillsResource } from './normalize.js';
import type { NormalizedProfile } from './types.js';

export class ProfileNotFoundError extends Error {
  constructor(readonly player: string, readonly query: string | undefined, readonly available: string[]) {
    super(
      available.length === 0
        ? `${player} has no SkyBlock profiles.`
        : `${player} has no profile "${query}". Profiles: ${available.join(', ')}.`,
    );
    this.name = 'ProfileNotFoundError';
  }
}

export interface LoadedProfile {
  playerName: string;
  profile: NormalizedProfile;
  /** All of the player's profile names, for error messages and pickers. */
  profileNames: string[];
  fromCache: boolean;
}

/** Username (or UUID) + optional profile name to a normalized profile. Uses the 60s profile cache. */
export async function loadProfile(player: string, profileQuery?: string, opts: { skipCache?: boolean } = {}): Promise<LoadedProfile> {
  const { uuid, name } = await hypixel.resolvePlayer(player);
  const [profiles, skills] = await Promise.all([hypixel.getProfiles(uuid, opts), hypixel.getSkillsResource()]);
  const list = profiles.data.profiles ?? [];
  const names = list.map((p) => p.cute_name ?? p.profile_id);
  const raw = pickProfile(list, profileQuery);
  if (!raw) throw new ProfileNotFoundError(name, profileQuery, names);
  return {
    playerName: name,
    profile: normalizeProfile(raw, uuid, skills.data as SkillsResource, profiles.fetchedAt),
    profileNames: names,
    fromCache: profiles.fromCache,
  };
}
