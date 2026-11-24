import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { HypixelApiError, PlayerNotFoundError } from '../hypixel/client.js';
import { loadProfile, ProfileNotFoundError } from '../profile/load.js';
import { loadCatalogue, type Catalogue } from '../tasks/catalogue.js';
import { buildCoverage, formatRow, formatTotal, type Coverage } from '../tasks/coverage.js';
import { evaluateProgress, summarize } from '../tasks/progress.js';
import type { Command } from './index.js';
import { overviewEmbed } from './overview.js';

// Loaded once at startup: an invalid catalogue stops the bot instead of giving wrong answers.
const catalogue: Catalogue = loadCatalogue();

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
  if (err instanceof PlayerNotFoundError || err instanceof ProfileNotFoundError) return err.message;
  if (err instanceof HypixelApiError) return `Hypixel API error: ${err.message}`;
  throw err;
}

async function overview(interaction: ChatInputCommandInteraction): Promise<void> {
  const player = interaction.options.getString('player', true);
  const profileName = interaction.options.getString('profile') ?? undefined;
  await interaction.deferReply();
  try {
    const loaded = await loadProfile(player, profileName);
    // Ticks arrive in step 6 (/xp tick); until then nothing is ticked.
    const { progress } = evaluateProgress(catalogue, loaded.profile);
    await interaction.editReply({ embeds: [overviewEmbed(loaded.playerName, loaded.profile, summarize(progress), catalogue)] });
  } catch (err) {
    await interaction.editReply({ content: userError(err) });
  }
}

export const xp: Command = {
  data: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('SkyBlock XP optimizer')
    .addSubcommand((s) =>
      s
        .setName('overview')
        .setDescription('SkyBlock level, earned vs remaining eligible XP, and task status counts')
        .addStringOption((o) => o.setName('player').setDescription('Minecraft username').setRequired(true))
        .addStringOption((o) => o.setName('profile').setDescription('Profile name (default: selected profile)')),
    )
    .addSubcommand((s) => s.setName('coverage').setDescription('How much of SkyBlock XP the task catalogue covers')),

  async execute(interaction: ChatInputCommandInteraction) {
    switch (interaction.options.getSubcommand()) {
      case 'overview':
        await overview(interaction);
        return;
      case 'coverage':
        await interaction.reply({ embeds: [coverageEmbed(buildCoverage(catalogue))] });
        return;
      default:
        await interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
    }
  },
};
