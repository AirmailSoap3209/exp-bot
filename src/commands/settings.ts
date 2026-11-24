import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { loadProfile } from '../profile/load.js';
import { BRACKETS, parseRateValue, profileKey, userData } from '../storage/userData.js';
import { defaultExcluded } from '../tasks/catalogue.js';
import { catalogue, rateBook } from '../tasks/instance.js';
import { decideTick } from '../tasks/progress.js';
import { activities, findTask, searchActivities, searchTasks, type Choice } from '../tasks/search.js';
import { requireLinked } from './target.js';

const fmt = (n: number) => n.toLocaleString('en-US');

/** Categories a user can exclude: the ones that have tasks. */
export function excludableCategories(): { name: string; value: string }[] {
  return catalogue.meta.categories.filter((c) => catalogue.byCategory.has(c.id)).map((c) => ({ name: c.name, value: c.id }));
}

export async function link(i: ChatInputCommandInteraction): Promise<string> {
  const loaded = await loadProfile(i.options.getString('username', true), i.options.getString('profile') ?? undefined);
  const p = loaded.profile;
  await userData.setLink(i.user.id, { uuid: p.uuid, name: loaded.playerName, profileId: p.profileId, profileName: p.cuteName });
  const others = loaded.profileNames.filter((n) => n !== p.cuteName);
  return [
    `Linked **${loaded.playerName} · ${p.cuteName}**. Commands without \`player:\` now use it, and ticks and rate overrides apply to it.`,
    others.length ? `Other profiles: ${others.join(', ')} (\`/xp link ${loaded.playerName} profile:<name>\` to switch).` : '',
  ].filter(Boolean).join('\n');
}

export async function exclude(i: ChatInputCommandInteraction, excluded: boolean): Promise<string> {
  const category = i.options.getString('category', true);
  const name = catalogue.meta.categories.find((c) => c.id === category)?.name;
  if (!name) return `Unknown category "${category}".`;
  const list = await userData.setExcluded(i.user.id, category, excluded, defaultExcluded(catalogue));
  const names = list.map((c) => catalogue.meta.categories.find((m) => m.id === c)?.name ?? c);
  return `${excluded ? 'Excluded' : 'Included'} **${name}**. Excluded now: ${names.length ? names.join(', ') : 'nothing'}.`;
}

export async function tick(i: ChatInputCommandInteraction): Promise<string> {
  const input = i.options.getString('task', true);
  const task = findTask(catalogue, input);
  if (!task) return `No task matches "${input}". Pick one from the autocomplete list.`;
  const { link, loaded, key } = await requireLinked(i);
  const decision = decideTick(task, loaded.profile);
  if (!decision.ok) {
    if (decision.why === 'already_complete') return `**${task.name}** is already verified complete by the API, so it doesn't need a tick.`;
    const p = decision.progress;
    const shown = p.current === null ? 'not in your completed tasks' : `${fmt(p.current)}/${fmt(p.required)}`;
    return `The API shows **${task.name}** incomplete (${shown}). The API wins over ticks, so it can't be ticked.`;
  }
  const added = await userData.addTick(key, task.id);
  return added
    ? `Ticked **${task.name}** (+${task.xp} XP) on ${link.name} · ${link.profileName}. It counts as complete until the API shows otherwise.`
    : `**${task.name}** is already ticked.`;
}

export async function untick(i: ChatInputCommandInteraction): Promise<string> {
  const link = await userData.getLink(i.user.id);
  if (!link) return 'You have no linked account, so there are no ticks.';
  const input = i.options.getString('task', true);
  const task = findTask(catalogue, input);
  const removed = await userData.removeTicks(profileKey(link.uuid, link.profileId), [task?.id ?? input]);
  return removed.length ? `Unticked **${task?.name ?? input}**.` : `**${task?.name ?? input}** wasn't ticked.`;
}

export async function rate(i: ChatInputCommandInteraction): Promise<string> {
  const link = await userData.getLink(i.user.id);
  if (!link) return 'Rate overrides only apply to your linked profile. Run `/xp link <username>` first.';
  const activity = i.options.getString('activity', true);
  if (!activities(catalogue).some((a) => a.id === activity)) return `No activity "${activity}". Pick one from the autocomplete list.`;
  // Fixed-time tasks (fairy souls, minion crafts) don't use rates, so an override would do nothing.
  if (!rateBook.rates.has(activity)) return `\`${activity}\` uses fixed time estimates, not a rate, so there's nothing to override.`;
  const parsed = parseRateValue(i.options.getString('value', true));
  if (!parsed.ok) return parsed.error;
  const key = profileKey(link.uuid, link.profileId);
  const changed = await userData.setRateOverride(key, activity, parsed.override);
  const count = Object.keys(await userData.getRateOverrides(key)).length;
  const what = !parsed.override
    ? changed ? `Cleared the override for \`${activity}\`.` : `\`${activity}\` had no override.`
    : 'bracket' in parsed.override
      ? `\`${activity}\` now uses the **${parsed.override.bracket}** bracket.`
      : `\`${activity}\` now uses a rate of **${parsed.override.rate}** (in that activity's unit).`;
  return `${what} ${count} override(s) on ${link.name} · ${link.profileName}. They take effect in \`/xp optimize\`.`;
}

/** Autocomplete for tick, untick and rate. */
export async function autocomplete(i: AutocompleteInteraction): Promise<Choice[]> {
  const sub = i.options.getSubcommand();
  const focused = i.options.getFocused(true);
  if (sub === 'tick' && focused.name === 'task') return searchTasks(catalogue.tasks, focused.value);
  if (sub === 'untick' && focused.name === 'task') {
    const link = await userData.getLink(i.user.id);
    if (!link) return [];
    const ticked = [...(await userData.getTicks(profileKey(link.uuid, link.profileId)))]
      .map((id) => catalogue.byId.get(id))
      .filter((t) => t !== undefined);
    return searchTasks(ticked, focused.value);
  }
  if (sub === 'rate' && focused.name === 'activity') return searchActivities(catalogue, focused.value, (id) => rateBook.rates.has(id));
  if (sub === 'rate' && focused.name === 'value') {
    const options = [...BRACKETS, 'default'].filter((b) => b.startsWith(focused.value.toLowerCase()));
    const n = Number(focused.value);
    if (focused.value && Number.isFinite(n) && n > 0) options.unshift(focused.value);
    return options.map((o) => ({ name: o === 'default' ? 'default (clear override)' : o, value: o }));
  }
  return [];
}
