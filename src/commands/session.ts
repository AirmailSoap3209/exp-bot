import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { loadProfile } from '../profile/load.js';
import {
  activityMetric, blend, changes, MAX_SESSION_MINUTES, measurableActivities, measure, MIN_SESSION_MINUTES, takeSnapshot,
} from '../sessions/sessions.js';
import { profileKey, userData, type OpenSession } from '../storage/userData.js';
import { catalogue, rateBook } from '../tasks/instance.js';
import { activities, searchActivities, type Choice } from '../tasks/search.js';
import { NotLinkedError } from './target.js';

const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : Number(n.toPrecision(3)).toLocaleString('en-US'));
const unitOf = (activity: string) => rateBook.rates.get(activity)?.unit.replace(/\/min$/, '') ?? '';
const labelOf = (activity: string) => activities(catalogue).find((a) => a.id === activity)?.label ?? activity;
const minutesSince = (t: number) => (Date.now() - t) / 60_000;

/** A fresh (uncached) snapshot of the session's profile: one keyed API call. */
async function freshSnapshot(uuid: string, profileId: string) {
  const loaded = await loadProfile(uuid, profileId, { skipCache: true });
  return { loaded, snapshot: takeSnapshot(catalogue, rateBook, loaded.profile) };
}

export async function start(i: ChatInputCommandInteraction): Promise<string> {
  const link = await userData.getLink(i.user.id);
  if (!link) throw new NotLinkedError();
  const activity = i.options.getString('activity', true);
  const target = activityMetric(catalogue, activity);
  if (!target || !measurableActivities(catalogue, rateBook).has(activity)) {
    return `\`${activity}\` can't be measured in a session. Pick an activity from the autocomplete list.`;
  }

  const open = await userData.getOpenSession(i.user.id);
  if (open) {
    if (minutesSince(open.startedAt) <= MAX_SESSION_MINUTES) {
      return `You already have a **${labelOf(open.activity)}** session running (${Math.round(minutesSince(open.startedAt))} min). End or cancel it first.`;
    }
    await userData.closeSession(i.user.id); // expired: drop it without saving
  }

  const { snapshot } = await freshSnapshot(link.uuid, link.profileId);
  const value = snapshot[target.metric];
  if (value === undefined) {
    return `Your profile doesn't show \`${target.metric}\` right now (an API setting may be off), so a **${labelOf(activity)}** session can't measure anything.`;
  }
  const session: OpenSession = {
    activity, metric: target.metric, category: target.category,
    uuid: link.uuid, profileId: link.profileId, playerName: link.name, profileName: link.profileName,
    startedAt: Date.now(), snapshot,
  };
  await userData.startSession(i.user.id, session);
  return [
    `Session started: **${labelOf(activity)}** on ${link.name} · ${link.profileName}.`,
    `Starting value: ${fmt(value)} ${unitOf(activity)}.`,
    `Play for at least ${MIN_SESSION_MINUTES} min, then run \`/xp session end\`. The API lags a few minutes, so wait a moment after you stop. Sessions expire after ${MAX_SESSION_MINUTES / 60} h.`,
  ].join('\n');
}

export async function end(i: ChatInputCommandInteraction): Promise<string> {
  const open = await userData.getOpenSession(i.user.id);
  if (!open) return 'No session is running. Start one with `/xp session start`.';
  const minutes = minutesSince(open.startedAt);
  if (minutes > MAX_SESSION_MINUTES) {
    await userData.closeSession(i.user.id);
    return `Your **${labelOf(open.activity)}** session was open for over ${MAX_SESSION_MINUTES / 60} h, so it expired without saving.`;
  }
  if (minutes < MIN_SESSION_MINUTES) {
    return `Only ${Math.floor(minutes)} min so far. Sessions need at least ${MIN_SESSION_MINUTES} min because the API lags behind play. Keep going, or \`/xp session cancel\`.`;
  }

  const { snapshot } = await freshSnapshot(open.uuid, open.profileId);
  await userData.closeSession(i.user.id);
  const m = measure(open.metric, open.snapshot, snapshot, minutes);
  const unit = unitOf(open.activity);
  const label = labelOf(open.activity);
  if (!m.ok) {
    return m.reason === 'no_data'
      ? `\`${open.metric}\` is no longer visible on your profile, so nothing could be measured. Nothing saved.`
      : `No change in ${unit} over ${Math.round(minutes)} min. The API may not have caught up yet, or the play didn't count toward **${label}**. Nothing saved.`;
  }

  const key = profileKey(open.uuid, open.profileId);
  const previous = (await userData.getSessionRates(key))[open.activity];
  const next = blend(previous, m.rate, m.minutes, new Date().toISOString());
  await userData.setSessionRate(key, open.activity, next);

  const others = changes(open.snapshot, snapshot).filter((c) => c.metric !== open.metric).slice(0, 5);
  return [
    `**${label}** session saved: +${fmt(m.delta)} ${unit} in ${Math.round(m.minutes)} min = **${fmt(m.rate)} ${unit}/min**.`,
    previous
      ? `Blended with ${previous.sessions} earlier session(s): ${fmt(previous.rate)} → **${fmt(next.rate)} ${unit}/min**.`
      : `First session for this activity: **${fmt(next.rate)} ${unit}/min**.`,
    '`/xp optimize` now uses this rate for your linked profile.',
    others.length ? `Also moved this session (not saved): ${others.map((c) => `\`${c.metric}\` +${fmt(c.delta)}`).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export async function status(i: ChatInputCommandInteraction): Promise<string> {
  const lines: string[] = [];
  const open = await userData.getOpenSession(i.user.id);
  if (open) {
    const minutes = minutesSince(open.startedAt);
    const state =
      minutes > MAX_SESSION_MINUTES ? 'expired; it will be dropped' :
      minutes < MIN_SESSION_MINUTES ? `can end in ${Math.ceil(MIN_SESSION_MINUTES - minutes)} min` :
      `ready to end; expires in ${Math.round(MAX_SESSION_MINUTES - minutes)} min`;
    lines.push(`Running: **${labelOf(open.activity)}** on ${open.playerName} · ${open.profileName}, ${Math.floor(minutes)} min (${state}).`);
  } else lines.push('No session running.');

  const link = await userData.getLink(i.user.id);
  if (link) {
    const rates = Object.entries(await userData.getSessionRates(profileKey(link.uuid, link.profileId)));
    if (rates.length) {
      lines.push('', `Measured rates on ${link.name} · ${link.profileName}:`);
      for (const [activity, r] of rates.sort((a, b) => b[1].sessions - a[1].sessions).slice(0, 15)) {
        lines.push(`• ${labelOf(activity)}: ${fmt(r.rate)} ${unitOf(activity)}/min (${r.sessions} session${r.sessions === 1 ? '' : 's'})`);
      }
    } else lines.push('', 'No measured rates yet.');
  }
  return lines.join('\n');
}

export async function cancel(i: ChatInputCommandInteraction): Promise<string> {
  const closed = await userData.closeSession(i.user.id);
  return closed ? `Cancelled the **${labelOf(closed.activity)}** session. Nothing saved.` : 'No session is running.';
}

export function autocomplete(i: AutocompleteInteraction): Choice[] {
  const focused = i.options.getFocused(true);
  if (focused.name !== 'activity') return [];
  const ok = measurableActivities(catalogue, rateBook);
  return searchActivities(catalogue, focused.value, (id) => ok.has(id));
}
