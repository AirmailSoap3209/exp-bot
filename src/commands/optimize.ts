import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { Estimate } from '../estimate/estimate.js';
import type { RankedTask, RankResult } from '../optimizer/rank.js';
import type { NormalizedProfile } from '../profile/types.js';
import { dataAge } from './overview.js';

export const PAGE_SIZE = 5;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** "<1 min", "~2–5 min", "~1.5–4 h", "~12–30 h": minutes under an hour, hours above. */
export function formatMinutes([lo, hi]: [number, number]): string {
  if (hi < 1) return '<1 min';
  let a: string, b: string, unit: string;
  if (hi < 60) {
    [a, b, unit] = [lo < 1 ? '<1' : String(Math.round(lo)), String(Math.round(hi)), 'min'];
  } else {
    const h = (m: number) => String(Number((m / 60).toFixed(m < 600 ? 1 : 0)));
    [a, b, unit] = [h(lo), h(hi), 'h'];
  }
  return a === b ? `~${b} ${unit}` : `~${a}–${b} ${unit}`;
}

function sourceLabel(e: Estimate): string {
  if (e.source === 'fixed') return 'fixed estimate';
  if (e.source === 'session') return 'session rate';
  if (e.source === 'override') return e.bracket ? `your override: ${e.bracket}` : 'your rate';
  const info = e.bracketInfo;
  return `${e.bracket} bracket${info && !info.known ? ', assumed (no data)' : ''}`;
}

/** One ranked entry in the spec's four-line format. */
export function formatEntry(n: number, r: RankedTask): string {
  const { task, current, required, remaining, status } = r.progress;
  const e = r.estimate;
  const unit = e.unit ? ` ${e.unit}` : '';
  let progress: string;
  if (required === 1 && (current ?? 0) === 0) progress = 'Not done yet';
  else if (current === null) progress = `No progress data · needs ${fmt(required)}${unit}`;
  else progress = `Progress ${fmt(current)}/${fmt(required)}${unit} · ${fmt(remaining ?? required - current)} left`;
  const where = [task.location, status === 'estimated' ? 'estimated' : 'verified'].filter(Boolean).join(' · ');
  return [
    `**${n}. ${task.name}**`,
    `${progress} · +${task.xp} XP`,
    `${formatMinutes(e.minutes)} (${sourceLabel(e)}) · ${e.xpPerMin >= 10 ? fmt(e.xpPerMin) : e.xpPerMin.toFixed(e.xpPerMin >= 1 ? 1 : 2)} XP/min`,
    where,
  ].join('\n');
}

export function optimizeEmbed(playerName: string, profile: NormalizedProfile, result: RankResult, page: number, opts: { now?: number; isLinked?: boolean } = {}): EmbedBuilder {
  const pages = Math.max(1, Math.ceil(result.ranked.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const entries = result.ranked.slice(start, start + PAGE_SIZE).map((r, i) => formatEntry(start + i + 1, r));
  const d = result.dropped;
  const notes = [
    d.unavailable ? `${fmt(d.unavailable)} tasks have no data and aren't ranked (see /xp overview).` : '',
    d.noRate ? `${fmt(d.noRate)} tasks have no rate yet.` : '',
    'Times use placeholder rates until tuned with `/xp rate` or sessions.',
  ].filter(Boolean);
  return new EmbedBuilder()
    .setTitle(`Quickest SkyBlock XP · ${playerName} · ${profile.cuteName}`)
    .setDescription([entries.length ? entries.join('\n\n') : 'Nothing left to rank. Every eligible task is done, blocked or has no data.', '', ...notes.map((n) => `-# ${n}`)].join('\n'))
    .setFooter({
      text: [profile.cuteName, `data ${dataAge(profile.fetchedAt, opts.now)}`, 'monetary tasks excluded', opts.isLinked ? 'your overrides applied' : '', `page ${page + 1}/${pages}`]
        .filter(Boolean).join(' · '),
    });
}

export function pageButtons(stateId: string, page: number, total: number): ActionRowBuilder<ButtonBuilder> {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`xpopt:${stateId}:${page - 1}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`xpopt:${stateId}:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  );
}
