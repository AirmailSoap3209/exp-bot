import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { rankTasks, type RankResult } from '../optimizer/rank.js';
import { profileKey, userData } from '../storage/userData.js';
import type { NormalizedProfile } from '../profile/types.js';
import { optimizeEmbed, pageButtons } from './optimize.js';
import { HypixelApiError, PlayerNotFoundError } from '../hypixel/client.js';
import { ProfileNotFoundError } from '../profile/load.js';
import { catalogue, rateBook } from '../tasks/instance.js';
import { buildCoverage, formatRow, formatTotal, type Coverage } from '../tasks/coverage.js';
import { summarize } from '../tasks/progress.js';
import type { Command } from './index.js';
import { overviewEmbed } from './overview.js';
import * as session from './session.js';
import * as settings from './settings.js';
import { NotLinkedError, resolveTarget } from './target.js';

export function coverageEmbed(c: Coverage): EmbedBuilder {
  const section = (status: 'v1' | 'later' | 'never') =>
    c.rows.filter((r) => r.status === status).map((r) => `• ${formatRow(r)}`).join('\n') || '—';
  const guides = c.guides
    .map((g) => {
      const max = g.maxXp !== null ? g.maxXp.toLocaleString('en-US') : g.wikiEstimate !== null ? `~${g.wikiEstimate.toLocaleString('en-US')}` : '?';
      return `${g.name}: ${g.catalogueXp.toLocaleString('en-US')} / ${max}`;
    })
    .join('\n');
  return new EmbedBuilder()
    .setTitle('SkyBlock XP coverage')
    .setDescription(formatTotal(c.total, c.checked))
    .addFields(
      { name: 'In v1', value: section('v1') },
      { name: 'Later versions', value: section('later') },
      { name: 'Excluded (monetary)', value: section('never') },
      { name: 'By SkyBlock Guide category', value: guides },
    )
    .setFooter({ text: 'Built from data/tasks and data/meta.json' });
}

/** Turns expected failures into a message for the user; rethrows anything else. */
function userError(err: unknown): string {
  if (err instanceof PlayerNotFoundError || err instanceof ProfileNotFoundError || err instanceof NotLinkedError) return err.message;
  if (err instanceof HypixelApiError) return `Hypixel API error: ${err.message}`;
  throw err;
}

async function overview(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const t = await resolveTarget(i);
    const summary = summarize(t.evaluation.progress, t.excluded);
    await i.editReply({
      embeds: [overviewEmbed(t.loaded.playerName, t.loaded.profile, summary, catalogue, { excluded: t.excluded, isLinked: t.isLinked, clearedTicks: t.clearedTicks })],
    });
  } catch (err) {
    await i.editReply({ content: userError(err) });
  }
}

/** Rankings kept for Next/Prev, so paging never re-fetches. Expire after 15 minutes. */
const pages = new Map<string, { userId: string; playerName: string; profile: NormalizedProfile; result: RankResult; isLinked: boolean; expires: number }>();
const PAGE_TTL_MS = 15 * 60_000;

async function optimize(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const t = await resolveTarget(i);
    const key = profileKey(t.loaded.profile.uuid, t.loaded.profile.profileId);
    // Overrides and measured session rates only apply to the caller's linked profile.
    const [overrides, sessionRates] = t.isLinked
      ? await Promise.all([userData.getRateOverrides(key), userData.getSessionRateNumbers(key)])
      : [undefined, undefined];
    const result = rankTasks(t.evaluation.progress, t.loaded.profile, { book: rateBook, overrides, sessionRates }, { excluded: t.excluded, limit: 10 });
    const now = Date.now();
    for (const [k, v] of pages) if (v.expires < now) pages.delete(k);
    const id = randomUUID().slice(0, 8);
    pages.set(id, { userId: i.user.id, playerName: t.loaded.playerName, profile: t.loaded.profile, result, isLinked: t.isLinked, expires: now + PAGE_TTL_MS });
    const content = t.clearedTicks.length ? `Cleared ${t.clearedTicks.length} tick(s) the API now shows incomplete.` : undefined;
    await i.editReply({
      content,
      embeds: [optimizeEmbed(t.loaded.playerName, t.loaded.profile, result, 0, { isLinked: t.isLinked })],
      components: result.ranked.length > 5 ? [pageButtons(id, 0, result.ranked.length)] : [],
    });
  } catch (err) {
    await i.editReply({ content: userError(err) });
  }
}

async function optimizePage(i: ButtonInteraction): Promise<void> {
  const [, id, pageStr] = i.customId.split(':');
  const state = pages.get(id ?? '');
  if (!state || state.expires < Date.now()) {
    await i.reply({ content: 'This ranking has expired. Run `/xp optimize` again.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (state.userId !== i.user.id) {
    await i.reply({ content: 'Only the person who ran this command can page it.', flags: MessageFlags.Ephemeral });
    return;
  }
  const page = Number(pageStr);
  await i.update({
    embeds: [optimizeEmbed(state.playerName, state.profile, state.result, page, { isLinked: state.isLinked })],
    components: [pageButtons(id!, page, state.result.ranked.length)],
  });
}

/** Settings replies are private; the work may hit the API, so defer first. */
async function privately(i: ChatInputCommandInteraction, run: () => Promise<string>): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await i.editReply({ content: await run() });
  } catch (err) {
    await i.editReply({ content: userError(err) });
  }
}

const categoryOption = (verb: string) => (o: import('discord.js').SlashCommandStringOption) =>
  o.setName('category').setDescription(`Category to ${verb}`).setRequired(true).addChoices(...settings.excludableCategories());

export const xp: Command = {
  data: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('SkyBlock XP optimizer')
    .addSubcommand((s) =>
      s.setName('link').setDescription('Link your Minecraft account and pick a profile')
        .addStringOption((o) => o.setName('username').setDescription('Minecraft username').setRequired(true))
        .addStringOption((o) => o.setName('profile').setDescription('Profile name (default: selected profile)')),
    )
    .addSubcommand((s) =>
      s.setName('overview').setDescription('SkyBlock level, earned vs remaining eligible XP, and task status counts')
        .addStringOption((o) => o.setName('player').setDescription('Minecraft username (default: your linked account)'))
        .addStringOption((o) => o.setName('profile').setDescription('Profile name (default: linked or selected profile)')),
    )
    .addSubcommand((s) =>
      s.setName('optimize').setDescription('The 10 quickest SkyBlock XP tasks left, without buying progression')
        .addStringOption((o) => o.setName('player').setDescription('Minecraft username (default: your linked account)'))
        .addStringOption((o) => o.setName('profile').setDescription('Profile name (default: linked or selected profile)')),
    )
    .addSubcommand((s) => s.setName('exclude').setDescription('Leave a category out of overview and rankings').addStringOption(categoryOption('exclude')))
    .addSubcommand((s) => s.setName('include').setDescription('Bring an excluded category back').addStringOption(categoryOption('include')))
    .addSubcommand((s) =>
      s.setName('tick').setDescription('Mark a task done on your linked profile when the API can\'t tell')
        .addStringOption((o) => o.setName('task').setDescription('Task name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s.setName('untick').setDescription('Remove a manual tick')
        .addStringOption((o) => o.setName('task').setDescription('Ticked task').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s.setName('rate').setDescription('Override the effort rate for an activity on your linked profile')
        .addStringOption((o) => o.setName('activity').setDescription('Activity').setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName('value').setDescription('early, mid, late, a number, or default to clear').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommandGroup((g) =>
      g.setName('session').setDescription('Measure your own rate for an activity')
        .addSubcommand((s) =>
          s.setName('start').setDescription('Snapshot your linked profile and start timing an activity')
            .addStringOption((o) => o.setName('activity').setDescription('What you are about to do').setRequired(true).setAutocomplete(true)),
        )
        .addSubcommand((s) => s.setName('end').setDescription('Snapshot again and save the measured rate (15 min minimum)'))
        .addSubcommand((s) => s.setName('status').setDescription('The running session and your measured rates'))
        .addSubcommand((s) => s.setName('cancel').setDescription('Drop the running session without saving')),
    )
    .addSubcommand((s) => s.setName('coverage').setDescription('How much of SkyBlock XP the task catalogue covers')),

  async execute(i: ChatInputCommandInteraction) {
    if (i.options.getSubcommandGroup(false) === 'session') {
      switch (i.options.getSubcommand()) {
        case 'start': return privately(i, () => session.start(i));
        case 'end': return privately(i, () => session.end(i));
        case 'status': return privately(i, () => session.status(i));
        case 'cancel': return privately(i, () => session.cancel(i));
      }
    }
    switch (i.options.getSubcommand()) {
      case 'overview': return overview(i);
      case 'optimize': return optimize(i);
      case 'link': return privately(i, () => settings.link(i));
      case 'exclude': return privately(i, () => settings.exclude(i, true));
      case 'include': return privately(i, () => settings.exclude(i, false));
      case 'tick': return privately(i, () => settings.tick(i));
      case 'untick': return privately(i, () => settings.untick(i));
      case 'rate': return privately(i, () => settings.rate(i));
      case 'coverage':
        await i.reply({ embeds: [coverageEmbed(buildCoverage(catalogue))] });
        return;
      default:
        await i.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
    }
  },

  async autocomplete(i: AutocompleteInteraction) {
    await i.respond(i.options.getSubcommandGroup(false) === 'session' ? session.autocomplete(i) : await settings.autocomplete(i));
  },

  async button(i: ButtonInteraction) {
    if (i.customId.startsWith('xpopt:')) await optimizePage(i);
  },
};
