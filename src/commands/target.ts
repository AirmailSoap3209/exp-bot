import type { ChatInputCommandInteraction } from 'discord.js';
import { loadProfile, type LoadedProfile } from '../profile/load.js';
import { profileKey, userData, type Link } from '../storage/userData.js';
import { defaultExcluded } from '../tasks/catalogue.js';
import { catalogue } from '../tasks/instance.js';
import { evaluateProgress, type Evaluation } from '../tasks/progress.js';

export class NotLinkedError extends Error {
  constructor() {
    super('You have no linked account. Run `/xp link <username>` first, or pass `player:`.');
    this.name = 'NotLinkedError';
  }
}

export interface Target {
  loaded: LoadedProfile;
  /** True when this is the caller's linked player and profile: ticks and rate overrides apply. */
  isLinked: boolean;
  link?: Link;
  evaluation: Evaluation;
  excluded: Set<string>;
  /** Single sources (task groups) the caller excluded. */
  excludedSources: Set<string>;
  /** Activities the caller doesn't want recommended. */
  excludedActivities: Set<string>;
  /** Ticks removed because the API now shows those tasks incomplete. */
  clearedTicks: string[];
}

/**
 * Resolves `player:` / `profile:` options, defaulting to the caller's link,
 * evaluates every task, and clears ticks the API contradicts.
 */
export async function resolveTarget(interaction: ChatInputCommandInteraction, opts: { skipCache?: boolean } = {}): Promise<Target> {
  const discordId = interaction.user.id;
  const player = interaction.options.getString('player') ?? undefined;
  const profileOpt = interaction.options.getString('profile') ?? undefined;
  const [link, excluded, excludedSources, excludedActivities] = await Promise.all([
    userData.getLink(discordId),
    userData.getExcluded(discordId, defaultExcluded(catalogue)),
    userData.getExcludedSources(discordId),
    userData.getExcludedActivities(discordId),
  ]);

  let loaded: LoadedProfile;
  if (player) {
    loaded = await loadProfile(player, profileOpt, opts);
  } else {
    if (!link) throw new NotLinkedError();
    loaded = await loadProfile(link.uuid, profileOpt ?? link.profileId, opts);
    loaded.playerName = link.name;
  }

  const isLinked = !!link && loaded.profile.uuid === link.uuid && loaded.profile.profileId.replace(/-/g, '') === link.profileId.replace(/-/g, '');
  const key = profileKey(loaded.profile.uuid, loaded.profile.profileId);
  const ticks = isLinked ? await userData.getTicks(key) : new Set<string>();
  const evaluation = evaluateProgress(catalogue, loaded.profile, ticks);
  const clearedTicks = evaluation.ticksToClear.length ? await userData.removeTicks(key, evaluation.ticksToClear) : [];
  return { loaded, isLinked, link, evaluation, excluded, excludedSources, excludedActivities, clearedTicks };
}

/** Loads the caller's linked profile, for commands that only make sense on it (tick, rate). */
export async function requireLinked(interaction: ChatInputCommandInteraction): Promise<{ link: Link; loaded: LoadedProfile; key: string }> {
  const link = await userData.getLink(interaction.user.id);
  if (!link) throw new NotLinkedError();
  const loaded = await loadProfile(link.uuid, link.profileId);
  loaded.playerName = link.name;
  return { link, loaded, key: profileKey(link.uuid, link.profileId) };
}
