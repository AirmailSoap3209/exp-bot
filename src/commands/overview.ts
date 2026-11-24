import { EmbedBuilder } from 'discord.js';
import type { NormalizedProfile } from '../profile/types.js';
import type { Catalogue } from '../tasks/catalogue.js';
import { STATUS_LABEL, STATUSES, type ProgressSummary } from '../tasks/progress.js';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function dataAge(fetchedAt: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - fetchedAt) / 1000));
  return s < 60 ? `${s}s old` : `${Math.round(s / 60)}m old`;
}

export interface OverviewOptions {
  excluded?: ReadonlySet<string>;
  /** Whether ticks were applied (the caller's linked profile). */
  isLinked?: boolean;
  clearedTicks?: string[];
  now?: number;
}

export function overviewEmbed(
  playerName: string,
  profile: NormalizedProfile,
  summary: ProgressSummary,
  catalogue: Catalogue,
  opts: OverviewOptions = {},
): EmbedBuilder {
  const { experience, level } = profile.leveling;
  const eligible = summary.earned + summary.remaining + summary.likelyComplete + summary.unknown;
  const names = new Map(catalogue.meta.categories.map((c) => [c.id, c.name]));

  const xpLines = [
    `**Level ${level}** · ${fmt(experience)} SkyBlock XP (${experience % 100}/100 to level ${level + 1})`,
    '',
    `Catalogue XP earned: **${fmt(summary.earned)}** of ${fmt(eligible)} eligible`,
    `Remaining eligible: **${fmt(summary.remaining)}** known` +
      (summary.likelyComplete ? ` · ${fmt(summary.likelyComplete)} estimated done` : '') +
      (summary.unknown ? ` · ${fmt(summary.unknown)} unknown (no data)` : ''),
    `Other SkyBlock XP (outside the catalogue or excluded): ${fmt(Math.max(0, experience - summary.earned))}`,
  ];
  if (opts.excluded?.size) {
    xpLines.push(`Excluded by you: ${[...opts.excluded].map((c) => names.get(c) ?? c).join(', ')}`);
  }
  if (opts.clearedTicks?.length) {
    const list = opts.clearedTicks.map((id) => catalogue.byId.get(id)?.name ?? id).join(', ');
    xpLines.push(`Cleared ${opts.clearedTicks.length} tick(s) the API now shows incomplete: ${list}`);
  }

  const counts = STATUSES.map((s) => `${STATUS_LABEL[s]}: ${fmt(summary.counts[s])}`).join('\n');

  const categories = [...summary.byCategory]
    .map(([id, b]) => {
      const total = b.earned + b.remaining + b.likelyComplete + b.unknown;
      if (b.unknown === total) return `**${names.get(id) ?? id}** · unavailable (${[...b.unavailableReasons][0] ?? 'no data'})`;
      const extra = [b.likelyComplete ? `~${fmt(b.likelyComplete)} est. done` : '', b.unknown ? `${fmt(b.unknown)} unknown` : ''].filter(Boolean).join(', ');
      const tag = b.counts.estimated ? ' · estimated' : '';
      return `**${names.get(id) ?? id}** · ${fmt(b.earned)}/${fmt(total)} XP${extra ? ` (${extra})` : ''}${tag}`;
    })
    .join('\n');

  const footer = [
    profile.cuteName,
    `data ${dataAge(profile.fetchedAt, opts.now)}`,
    opts.isLinked ? 'your linked profile' : 'ticks not applied',
    'monetary tasks excluded',
  ].join(' · ');

  return new EmbedBuilder()
    .setTitle(`${playerName} · ${profile.cuteName}${profile.gameMode !== 'normal' ? ` (${profile.gameMode})` : ''}`)
    .setDescription(xpLines.join('\n'))
    .addFields(
      { name: 'By category', value: categories || 'Every category is excluded.' },
      { name: 'Task status', value: counts },
    )
    .setFooter({ text: footer });
}
