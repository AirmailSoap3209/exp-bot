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
import { optimizeEmbed, pageButtons, PAGE_SIZE } from './optimize.js';
import { TARGET_PAGE_SIZE, targetEmbed, targetLineCount } from './targetPlan.js';
import { planTarget, xpToLevel } from '../optimizer/target.js';
import { taskEmbed } from './taskDetail.js';
import { categoryView } from '../optimizer/category.js';
import { estimateTask, type EstimateContext } from '../estimate/estimate.js';
import { findTask, searchTasks, sourceId } from '../tasks/search.js';
import { HypixelApiError, PlayerNotFoundError } from '../hypixel/client.js';
import { ProfileNotFoundError } from '../profile/load.js';
import { catalogue, rateBook } from '../tasks/instance.js';
import { buildCoverage, formatRow, formatTotal, type Coverage } from '../tasks/coverage.js';
import { summarize } from '../tasks/progress.js';
import type { Command } from './index.js';
import { overviewEmbed } from './overview.js';
import * as session from './session.js';
import * as settings from './settings.js';
import { NotLinkedError, resolveTarget, type Target } from './target.js';

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
    const summary = summarize(t.evaluation.progress, t.excluded, t.excludedSources);
    await i.editReply({
      embeds: [overviewEmbed(t.loaded.playerName, t.loaded.profile, summary, catalogue, {
        excluded: t.excluded, excludedSources: t.excludedSources, isLinked: t.isLinked, clearedTicks: t.clearedTicks,
      })],
    });
  } catch (err) {
    await i.editReply({ content: userError(err) });
  }
}

/** Paged results kept for Next/Prev, so paging never re-fetches or re-plans. Expire after 15 minutes. */
interface PageState {
  userId: string;
  render: (page: number) => EmbedBuilder;
  /** Entries and entries per page, for the buttons. */
  total: number;
  pageSize: number;
  expires: number;
}
const pages = new Map<string, PageState>();
const PAGE_TTL_MS = 15 * 60_000;

/** Estimator context: overrides and measured session rates only apply to the caller's linked profile. */
async function estimateContext(t: Target): Promise<EstimateContext> {
  if (!t.isLinked) return { book: rateBook };
  const key = profileKey(t.loaded.profile.uuid, t.loaded.profile.profileId);
  const [overrides, sessionRates] = await Promise.all([userData.getRateOverrides(key), userData.getSessionRateNumbers(key)]);
  return { book: rateBook, overrides, sessionRates };
}

/** Sends page 1 of a paged result, with Prev/Next when there is more than one page. */
async function showPaged(i: ChatInputCommandInteraction, t: Target, render: (page: number) => EmbedBuilder, total: number, pageSize: number): Promise<void> {
  const now = Date.now();
  for (const [k, v] of pages) if (v.expires < now) pages.delete(k);
  const id = randomUUID().slice(0, 8);
  pages.set(id, { userId: i.user.id, render, total, pageSize, expires: now + PAGE_TTL_MS });
  const content = t.clearedTicks.length ? `Cleared ${t.clearedTicks.length} tick(s) the API now shows incomplete.` : undefined;
  await i.editReply({ content, embeds: [render(0)], components: total > pageSize ? [pageButtons(id, 0, total, pageSize)] : [] });
}

async function showRanking(i: ChatInputCommandInteraction, t: Target, result: RankResult, view: { title?: string; header?: string } = {}): Promise<void> {
  const { playerName } = t.loaded;
  const { profile } = t.loaded;
  const render = (page: number) => optimizeEmbed(playerName, profile, result, page, { isLinked: t.isLinked, ...view });
  await showPaged(i, t, render, result.ranked.length, PAGE_SIZE);
}

async function target(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const xpOpt = i.options.getInteger('xp');
    const levelOpt = i.options.getInteger('level');
    if ((xpOpt === null) === (levelOpt === null)) {
      await i.editReply({ content: 'Give either `xp:` (XP to gain) or `level:` (SkyBlock level to reach), not both.' });
      return;
    }
    const t = await resolveTarget(i);
    const { profile, playerName } = t.loaded;
    const need = xpOpt ?? xpToLevel(levelOpt!, profile.leveling.experience);
    if (need <= 0) {
      await i.editReply({ content: `${playerName} is already level ${profile.leveling.level}, at or above level ${levelOpt}.` });
      return;
    }
    const plan = planTarget(t.evaluation.progress, profile, await estimateContext(t), need, { excluded: t.excluded, excludedSources: t.excludedSources });
    const ask = levelOpt !== null ? { kind: 'level' as const, level: levelOpt } : { kind: 'xp' as const, xp: need };
    const render = (page: number) => targetEmbed(playerName, profile, plan, page, { ask, isLinked: t.isLinked });
    await showPaged(i, t, render, targetLineCount(plan), TARGET_PAGE_SIZE);
  } catch (err) {
    await i.editReply({ content: userError(err) });
  }
}

async function optimize(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const t = await resolveTarget(i);
    const result = rankTasks(t.evaluation.progress, t.loaded.profile, await estimateContext(t), { excluded: t.excluded, excludedSources: t.excludedSources, limit: 10 });
    await showRanking(i, t, result);
  } catch (err) {
    await i.editReply({ content: userError(err) });
  }
}

async function category(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const id = i.options.getString('category', true);
    const meta = catalogue.meta.categories.find((c) => c.id === id);
    if (!meta || !catalogue.byCategory.has(id)) {
      await i.editReply({ content: `No tasks in category "${id}".` });
      return;
    }
    const t = await resolveTarget(i);
    const view = categoryView(catalogue, t.evaluation.progress, t.loaded.profile, await estimateContext(t), id, t.excludedSources);
    const s = view.summary;
    const fmt = (n: number) => n.toLocaleString('en-US');
    const total = s ? s.earned + s.remaining + s.likelyComplete + s.unknown : 0;
    const header = [
      `**${meta.name}** · ${fmt(s?.earned ?? 0)}/${fmt(total)} XP earned · ${fmt(view.result.ranked.length)} open now, quickest first`,
      t.excluded.has(id) ? '-# This category is excluded from your overview and rankings; it is shown here anyway.' : '',
      view.hiddenSources ? `-# ${fmt(view.hiddenSources)} source(s) you excluded are hidden. \`/xp include source:\` brings one back.` : '',
    ].filter(Boolean).join('\n');
    await showRanking(i, t, view.result, { title: meta.name, header });
  } catch (err) {
    await i.editReply({ content: userError(err) });
  }
}

async function task(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  try {
    const input = i.options.getString('task', true);
    const found = findTask(catalogue, input);
    if (!found) {
      await i.editReply({ content: `No task matches "${input}". Pick one from the autocomplete list.` });
      return;
    }
    const link = await userData.getLink(i.user.id);
    if (!link) {
      await i.editReply({ embeds: [taskEmbed(found, catalogue, rateBook)] });
      return;
    }
    const t = await resolveTarget(i);
    const progress = new Map(t.evaluation.progress.map((p) => [p.task.id, p]));
    const p = progress.get(found.id)!;
    const estimate = estimateTask(p, t.loaded.profile, await estimateContext(t));
    const excludedBy = t.excluded.has(found.category) ? 'category' : t.excludedSources.has(sourceId(found)) ? 'source' : undefined;
    await i.editReply({ embeds: [taskEmbed(found, catalogue, rateBook, { playerName: t.loaded.playerName, profile: t.loaded.profile, progress, estimate, excludedBy })] });
  } catch (err) {
    await i.editReply({ content: userError(err) });
  }
}

async function optimizePage(i: ButtonInteraction): Promise<void> {
  const [, id, pageStr] = i.customId.split(':');
  const state = pages.get(id ?? '');
  if (!state || state.expires < Date.now()) {
    await i.reply({ content: 'This list has expired. Run the command again.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (state.userId !== i.user.id) {
    await i.reply({ content: 'Only the person who ran this command can page it.', flags: MessageFlags.Ephemeral });
    return;
  }
  const page = Number(pageStr);
  await i.update({ embeds: [state.render(page)], components: [pageButtons(id!, page, state.total, state.pageSize)] });
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
  o.setName('category').setDescription(`Category to ${verb}`).addChoices(...settings.excludableCategories());
const sourceOption = (verb: string) => (o: import('discord.js').SlashCommandStringOption) =>
  o.setName('source').setDescription(`One source to ${verb}, with all its tiers (e.g. Wheat collection)`).setAutocomplete(true);

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
    .addSubcommand((s) =>
      s.setName('target').setDescription('The quickest set of tasks to gain an amount of XP or reach a SkyBlock level')
        .addIntegerOption((o) => o.setName('xp').setDescription('SkyBlock XP to gain').setMinValue(1).setMaxValue(100_000))
        .addIntegerOption((o) => o.setName('level').setDescription('SkyBlock level to reach (100 XP per level)').setMinValue(1).setMaxValue(1_000))
        .addStringOption((o) => o.setName('player').setDescription('Minecraft username (default: your linked account)'))
        .addStringOption((o) => o.setName('profile').setDescription('Profile name (default: linked or selected profile)')),
    )
    .addSubcommand((s) =>
      s.setName('category').setDescription('Remaining tasks in one category, quickest first')
        .addStringOption((o) => o.setName('category').setDescription('Category').setRequired(true).addChoices(...settings.excludableCategories()))
        .addStringOption((o) => o.setName('player').setDescription('Minecraft username (default: your linked account)'))
        .addStringOption((o) => o.setName('profile').setDescription('Profile name (default: linked or selected profile)')),
    )
    .addSubcommand((s) =>
      s.setName('task').setDescription('Full detail for one task')
        .addStringOption((o) => o.setName('task').setDescription('Task name').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s.setName('exclude').setDescription('Leave a category or one source out of overview and rankings (no options: list)')
        .addStringOption(categoryOption('exclude')).addStringOption(sourceOption('exclude')),
    )
    .addSubcommand((s) =>
      s.setName('include').setDescription('Bring an excluded category or source back (no options: list)')
        .addStringOption(categoryOption('include')).addStringOption(sourceOption('include')),
    )
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
      case 'target': return target(i);
      case 'category': return category(i);
      case 'task': return task(i);
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
    if (i.options.getSubcommandGroup(false) === 'session') return i.respond(session.autocomplete(i));
    if (i.options.getSubcommand() === 'task') return i.respond(searchTasks(catalogue.tasks, i.options.getFocused()));
    await i.respond(await settings.autocomplete(i));
  },

  async button(i: ButtonInteraction) {
    if (i.customId.startsWith('xpopt:')) await optimizePage(i);
  },
};
