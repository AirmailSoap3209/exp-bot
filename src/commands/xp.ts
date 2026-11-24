import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { HypixelApiError, PlayerNotFoundError } from '../hypixel/client.js';
import { ProfileNotFoundError } from '../profile/load.js';
import { catalogue } from '../tasks/instance.js';
import { buildCoverage, formatRow, formatTotal, type Coverage } from '../tasks/coverage.js';
import { summarize } from '../tasks/progress.js';
import type { Command } from './index.js';
import { overviewEmbed } from './overview.js';
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
    .addSubcommand((s) => s.setName('coverage').setDescription('How much of SkyBlock XP the task catalogue covers')),

  async execute(i: ChatInputCommandInteraction) {
    switch (i.options.getSubcommand()) {
      case 'overview': return overview(i);
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
    await i.respond(await settings.autocomplete(i));
  },
};
