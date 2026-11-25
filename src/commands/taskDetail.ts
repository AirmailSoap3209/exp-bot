import { EmbedBuilder } from 'discord.js';
import type { Combo } from '../combos/combos.js';
import type { Estimate } from '../estimate/estimate.js';
import type { RateBook } from '../estimate/rates.js';
import type { NormalizedProfile } from '../profile/types.js';
import type { Catalogue } from '../tasks/catalogue.js';
import { STATUS_LABEL, type TaskProgress } from '../tasks/progress.js';
import type { Task } from '../tasks/types.js';
import { formatMinutes } from './optimize.js';
import { dataAge } from './overview.js';

const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : Number(n.toPrecision(3)).toLocaleString('en-US'));
const clip = (s: string, n = 1024) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export interface TaskDetailContext {
  playerName: string;
  profile: NormalizedProfile;
  progress: Map<string, TaskProgress>;
  estimate?: Estimate;
  /** Set when the caller's exclusions leave this task out of rankings. */
  excludedBy?: 'category' | 'source' | 'activity';
  now?: number;
}

function estimateText(e: Estimate | undefined, p: TaskProgress | undefined): string {
  if (!p) return 'Link your account (`/xp link`) to see an estimate for your profile.';
  if (p.status === 'verified_complete' || p.status === 'ticked') return 'Done.';
  if (!e) return 'No rate for this activity, so no estimate.';
  const lines = [`${formatMinutes(e.minutes)} · ${e.xpPerMin >= 10 ? fmt(e.xpPerMin) : e.xpPerMin.toFixed(2)} XP/min`];
  if (e.source === 'fixed') lines.push('Fixed time estimate for this task.');
  else {
    const rate = e.rate ? `${fmt(e.rate[0])}–${fmt(e.rate[1])} ${e.unit}/min` : '';
    const from =
      e.source === 'session' ? 'your measured session rate' :
      e.source === 'override' ? (e.bracket ? `your override (${e.bracket} bracket)` : 'your override') :
      `${e.bracket} bracket${e.bracketInfo ? ` (${e.bracketInfo.known ? e.bracketInfo.detail : `assumed: ${e.bracketInfo.detail}`})` : ''}`;
    lines.push(`Rate: ${rate}, from ${from}.`);
  }
  if (e.assumedNoProgress) lines.push('The API shows no progress number, so the whole requirement is assumed left.');
  return lines.join('\n');
}

/** Everything the bot knows about one task, with the caller's progress when available. */
export function taskEmbed(task: Task, catalogue: Catalogue, book: RateBook, ctx?: TaskDetailContext, alsoBy: readonly Combo[] = []): EmbedBuilder {
  const p = ctx?.progress.get(task.id);
  const unit = task.activity ? book.rates.get(task.activity)?.unit.replace(/\/min$/, '') ?? '' : '';
  const category = catalogue.meta.categories.find((c) => c.id === task.category)?.name ?? task.category;
  const group = task.group ? catalogue.tasks.filter((t) => t.group === task.group) : [];
  const next = group.find((t) => t.prerequisites.includes(task.id));

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Reward', value: `+${task.xp} SkyBlock XP`, inline: true },
    { name: 'Category', value: `${category}${group.length > 1 ? ` · tier ${task.tier} of ${group.length}` : ''}`, inline: true },
    { name: 'Requires', value: `${fmt(task.requires.amount)}${unit ? ` ${unit}` : ''} (\`${task.requires.metric}\`)`, inline: true },
  ];

  if (p) {
    const progress =
      p.current === null ? 'No progress number from the API.' :
      `${fmt(p.current)}/${fmt(p.required)}${unit ? ` ${unit}` : ''}${p.remaining ? ` · ${fmt(p.remaining)} left` : ''}`;
    const extra = [p.reason, p.blocked ? `Blocked: ${p.blocked}.` : '', p.likelyComplete ? 'The estimate says this is probably done.' : ''].filter(Boolean);
    fields.push({ name: 'Status', value: clip([`**${STATUS_LABEL[p.status]}**`, progress, ...extra].join('\n')) });
  }
  fields.push({ name: 'Estimate', value: clip(estimateText(ctx?.estimate, p)) });
  if (ctx?.excludedBy) {
    fields.push({
      name: 'Excluded',
      value: ctx.excludedBy === 'category'
        ? `You excluded the ${category} category, so this isn't ranked. \`/xp include category:\` brings it back.`
        : ctx.excludedBy === 'source'
          ? `You excluded this source, so this isn't ranked. \`/xp include source:\` brings it back.`
          : `You excluded \`${task.activity}\`, so this isn't recommended on its own; its XP still counts when a combo finishes it. \`/xp include activity:\` brings it back.`,
    });
  }
  if (alsoBy.length) {
    fields.push({ name: 'Also progressed by', value: clip(alsoBy.map((c) => `⚡ ${c.name}${c.location ? ` (${c.location})` : ''}`).join('\n')) });
  }

  if (task.prerequisites.length) {
    fields.push({
      name: 'Prerequisites',
      value: clip(task.prerequisites.map((id) => {
        const pre = catalogue.byId.get(id);
        const st = ctx?.progress.get(id);
        return `• ${pre?.name ?? id}${st ? ` · ${STATUS_LABEL[st.status].toLowerCase()}${st.likelyComplete ? ' (probably done)' : ''}` : ''}`;
      }).join('\n')),
    });
  }
  if (next) fields.push({ name: 'Next tier', value: `${next.name} (+${next.xp} XP)`, inline: true });
  const where = [task.location, `tracked: ${task.tracking}`, task.hypixelTaskId ? `Hypixel task \`${task.hypixelTaskId}\`` : ''].filter(Boolean).join(' · ');
  fields.push({ name: 'Details', value: clip(where) });
  fields.push({ name: 'Source', value: clip(task.source) });

  return new EmbedBuilder()
    .setTitle(task.name)
    .setDescription(task.description)
    .addFields(fields)
    .setFooter({
      text: ctx
        ? `${ctx.playerName} · ${ctx.profile.cuteName} · data ${dataAge(ctx.profile.fetchedAt, ctx.now)} · task ${task.id}`
        : `Not linked: task data only · task ${task.id}`,
    });
}
