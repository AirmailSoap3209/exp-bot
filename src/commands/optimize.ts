import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { Estimate } from '../estimate/estimate.js';
import type { RankedTask, RankResult } from '../optimizer/rank.js';
import type { NormalizedProfile } from '../profile/types.js';
import { dataAge } from './overview.js';

export const PAGE_SIZE = 5;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** "<1 min", "~2–5 min", "~1.5–4 h", "~12–30 h", "~3–7 days": minutes under an hour, hours under two days, days above. */
export function formatMinutes([lo, hi]: [number, number]): string {
  if (hi < 1) return '<1 min';
  let a: string, b: string, unit: string;
  if (hi < 60) {
    [a, b, unit] = [lo < 1 ? '<1' : String(Math.round(lo)), String(Math.round(hi)), 'min'];
  } else if (hi >= 48 * 60) {
    const d = (m: number) => Number((m / 1440).toFixed(m < 14_400 ? 1 : 0)).toLocaleString('en-US');
    [a, b, unit] = [d(lo), d(hi), 'days'];
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

const xpRate = (x: number) => (x >= 10 ? fmt(x) : x.toFixed(x >= 1 ? 1 : 2));

/** A combo row: what it is, what it completes, how long, where. */
function formatCombo(n: number, r: RankedTask): string {
  const row = r.combo!;
  const shown = row.tasks.slice(0, 4).map((t) => `${t.name} (+${t.xp})`);
  const more = row.tasks.length > 4 ? ` · +${row.tasks.length - 4} more` : '';
  return [
    `**${n}. ⚡ ${row.combo.name}** · +${fmt(row.xp)} XP across ${row.tasks.length} task${row.tasks.length === 1 ? "" : "s"}`,
    `${shown.join(' · ')}${more}`,
    `${formatMinutes(row.minutes)} (${sourceLabel(r.estimate)}) · ${xpRate(r.estimate.xpPerMin)} XP/min`,
    [row.combo.location, row.measured.length ? 'your measured ratios, low end' : 'side tasks counted at the low end'].filter(Boolean).join(' · '),
  ].join('\n');
}

/** One ranked entry in the spec's four-line format. */
export function formatEntry(n: number, r: RankedTask): string {
  if (r.combo) return formatCombo(n, r);
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
    `${formatMinutes(e.minutes)} (${sourceLabel(e)}) · ${xpRate(e.xpPerMin)} XP/min`,
    where,
  ].join('\n');
}

export function optimizeEmbed(
  playerName: string,
  profile: NormalizedProfile,
  result: RankResult,
  page: number,
  opts: { now?: number; isLinked?: boolean; title?: string; header?: string } = {},
): EmbedBuilder {
  const pages = Math.max(1, Math.ceil(result.ranked.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const entries = result.ranked.slice(start, start + PAGE_SIZE).map((r, i) => formatEntry(start + i + 1, r));
  const d = result.dropped;
  const notes = [
    d.unavailable ? `${fmt(d.unavailable)} tasks have no data and aren't ranked (see /xp overview).` : '',
    d.noRate ? `${fmt(d.noRate)} tasks have no rate yet.` : '',
    opts.header && d.blocked ? `${fmt(d.blocked)} later tiers or tasks are waiting on a prerequisite.` : '',
    'Default rates are estimates; measure your own with `/xp session` or set them with `/xp rate`.',
  ].filter(Boolean);
  return new EmbedBuilder()
    .setTitle(`${opts.title ?? 'Quickest SkyBlock XP'} · ${playerName} · ${profile.cuteName}`)
    .setDescription([
      ...(opts.header ? [opts.header, ''] : []),
      entries.length ? entries.join('\n\n') : 'Nothing left to rank. Every eligible task is done, blocked or has no data.',
      '',
      ...notes.map((n) => `-# ${n}`),
    ].join('\n'))
    .setFooter({
      text: [profile.cuteName, `data ${dataAge(profile.fetchedAt, opts.now)}`, 'monetary tasks excluded', opts.isLinked ? 'your overrides applied' : '', `page ${page + 1}/${pages}`]
        .filter(Boolean).join(' · '),
    });
}

export function pageButtons(stateId: string, page: number, total: number, pageSize = PAGE_SIZE): ActionRowBuilder<ButtonBuilder> {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`xpopt:${stateId}:${page - 1}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`xpopt:${stateId}:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  );
}
