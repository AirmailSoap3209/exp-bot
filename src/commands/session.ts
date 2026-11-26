import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { metricLabel } from '../optimizer/category.js';
import { loadProfile } from '../profile/load.js';
import { yieldPer } from '../combos/combos.js';
import {
  activityMetric, blend, LINK_MIN_SESSIONS, linkStatus, MAX_SESSION_MINUTES, measurableActivities, measure, measureLinks, measureRatios, MIN_SESSION_MINUTES, takeSnapshot,
} from '../sessions/sessions.js';
import { profileKey, userData, type OpenSession } from '../storage/userData.js';
import { catalogue, combos, rateBook } from '../tasks/instance.js';
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
  const learns = combos.filter((c) => c.primary === activity)
    .flatMap((c) => c.yields.filter((y) => snapshot[y.metric] !== undefined).map((y) => `${metricLabel(catalogue, y.metric)} (${c.name})`));
  return [
    `Session started: **${labelOf(activity)}** on ${link.name} · ${link.profileName}.`,
    `Starting value: ${fmt(value)} ${unitOf(activity)}.`,
    learns.length ? `It also measures how much ${learns.join(', ')} you get per ${unitOf(activity).replace(/s$/, '')}, for ⚡ combo rows.` : '',
    `Anything else that goes up while you play (skill XP, collections, bestiary, HOTM XP…) is linked to this activity, and becomes part of its ⚡ combo once it shows up in ${LINK_MIN_SESSIONS} sessions.`,
    `Play for at least ${MIN_SESSION_MINUTES} min, then run \`/xp session end\`. The API lags a few minutes, so wait a moment after you stop. Sessions expire after ${MAX_SESSION_MINUTES / 60} h.`,
  ].filter(Boolean).join('\n');
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

  // Combos built on this activity learn each yield's ratio from what moved alongside it.
  const ratios = measureRatios(combos, open.activity, open.snapshot, snapshot, m.delta);
  const saved = await userData.getComboRatios(key);
  const ratioLines: string[] = [];
  for (const r of ratios) {
    const prev = saved[r.combo]?.[r.metric];
    const blended = blend(prev, r.ratio, m.minutes, new Date().toISOString());
    await userData.setComboRatio(key, r.combo, r.metric, blended);
    const c = combos.find((x) => x.id === r.combo)!;
    const y = c.yields.find((x) => x.metric === r.metric)!;
    const data = yieldPer(y, 'mid');
    ratioLines.push(`• ${c.name}: ${metricLabel(catalogue, r.metric)} **${fmt(blended.rate)}** per ${unit.replace(/s$/, '')}` +
      ` (this session ${fmt(r.ratio)}${prev ? `, ${blended.sessions} sessions` : ''}; data ${fmt(data[0])}${data[1] !== data[0] ? `–${fmt(data[1])}` : ''})`);
  }
  // Everything else that went up is linked to this activity. A link joins the activity's combo
  // (or makes one) once it has moved in LINK_MIN_SESSIONS sessions with ratios that agree.
  const ratioMetrics = new Set(ratios.map((r) => r.metric));
  const linked = measureLinks(open.metric, open.snapshot, snapshot, m.delta).filter((l) => !ratioMetrics.has(l.metric));
  const savedLinks = (await userData.getActivityLinks(key))[open.activity] ?? {};
  const learned: string[] = [];
  const pending: string[] = [];
  const noisy: string[] = [];
  const per = unit.replace(/s$/, '');
  for (const l of linked) {
    const prev = savedLinks[l.metric];
    const blended = blend(prev, l.ratio, m.minutes, new Date().toISOString());
    await userData.setActivityLink(key, open.activity, l.metric, blended);
    const name = metricLabel(catalogue, l.metric);
    const status = linkStatus(blended);
    if (status === 'inconsistent') noisy.push(`${name} (${fmt(l.ratio)} per ${per}, last time ${fmt(prev!.history[0]!.rate)})`);
    else (status === 'ready' ? learned : pending).push(`${name} +${fmt(l.delta)} (**${fmt(blended.rate)}** per ${per})`);
  }
  const cap = (list: string[]) => (list.length > 8 ? [...list.slice(0, 8), `…and ${list.length - 8} more`] : list);
  return [
    `**${label}** session saved: +${fmt(m.delta)} ${unit} in ${Math.round(m.minutes)} min = **${fmt(m.rate)} ${unit}/min**.`,
    previous
      ? `Blended with ${previous.sessions} earlier session(s): ${fmt(previous.rate)} → **${fmt(next.rate)} ${unit}/min**.`
      : `First session for this activity: **${fmt(next.rate)} ${unit}/min**.`,
    '`/xp optimize` now uses this rate for your linked profile.',
    ratioLines.length ? `Combo ratios saved (used for ⚡ rows on your linked profile):\n${ratioLines.join('\n')}` : '',
    learned.length ? `Linked to **${label}** (seen in ${LINK_MIN_SESSIONS}+ sessions, now part of its ⚡ combo):\n${cap(learned).map((x) => `• ${x}`).join('\n')}` : '',
    pending.length ? `Also went up (saved; counts toward ⚡ combos once it moves by a similar amount in another **${label}** session): ${cap(pending).join(', ')}` : '',
    noisy.length ? `Not linked, because the amount per ${per} didn't match last session (probably a minion, co-op mate or something done on the side): ${cap(noisy).join(', ')}` : '',
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
    const ratios = await userData.getComboRatios(profileKey(link.uuid, link.profileId));
    const ratioLines = Object.entries(ratios).flatMap(([id, byMetric]) => {
      const c = combos.find((x) => x.id === id);
      return Object.entries(byMetric).map(([metric, r]) =>
        `• ${c?.name ?? id}: ${metricLabel(catalogue, metric)} ${fmt(r.rate)} per ${c ? unitOf(c.primary).replace(/s$/, '') : 'unit'} (${r.sessions} session${r.sessions === 1 ? '' : 's'})`);
    });
    if (ratioLines.length) lines.push('', 'Measured combo ratios:', ...ratioLines.slice(0, 15));
    const links = await userData.getActivityLinks(profileKey(link.uuid, link.profileId));
    const linkLines = Object.entries(links).flatMap(([activity, byMetric]) => {
      const used = Object.entries(byMetric).filter(([, r]) => linkStatus(r) === 'ready').sort((a, b) => b[1].sessions - a[1].sessions);
      return used.length ? [`• ${labelOf(activity)}: ${used.slice(0, 4).map(([metric, r]) => `${metricLabel(catalogue, metric)} ${fmt(r.rate)} per ${unitOf(activity).replace(/s$/, '')}`).join(', ')}${used.length > 4 ? ` +${used.length - 4} more` : ''}`] : [];
    });
    if (linkLines.length) lines.push('', `Linked in your sessions (part of ⚡ combos):`, ...linkLines.slice(0, 15));
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
