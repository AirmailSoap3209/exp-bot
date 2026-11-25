import { EmbedBuilder } from 'discord.js';
import type { Range } from '../estimate/types.js';
import { sourceName } from '../optimizer/category.js';
import type { TargetPick, TargetPlan } from '../optimizer/target.js';
import type { NormalizedProfile } from '../profile/types.js';
import { formatMinutes } from './optimize.js';
import { dataAge } from './overview.js';

export const TARGET_PAGE_SIZE = 8;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** Back-to-back steps on the same source, shown as one line ("Combat level 31→33"). */
interface Line {
  steps: TargetPick[];
}

function group(plan: TargetPlan): Line[] {
  const lines: Line[] = [];
  for (const s of plan.picks) {
    const last = lines.at(-1);
    const g = s.progress.task.group;
    if (last && g && last.steps[0]!.progress.task.group === g) last.steps.push(s);
    else lines.push({ steps: [s] });
  }
  return lines;
}

/** "Combat level 31", or "Combat level 31→33" for a run of tiers. */
function lineName(steps: TargetPick[]): string {
  const first = steps[0]!.progress.task.name;
  if (steps.length === 1) return first;
  const last = steps.at(-1)!.progress.task.name;
  return `${first}→${last.slice(sourceName(last).length).trim().split(/\s+/).at(-1)}`;
}

/** One numbered line per run of steps, with running totals. */
export function targetLines(plan: TargetPlan): string[] {
  return group(plan).map((line, i) => {
    const xp = line.steps.reduce((n, s) => n + s.xp, 0);
    const minutes: Range = line.steps.reduce<Range>((r, s) => [r[0] + s.estimate.minutes[0], r[1] + s.estimate.minutes[1]], [0, 0]);
    const total = line.steps.at(-1)!.total;
    const picked = new Set(line.steps.map((s) => s.progress.task.id));
    const bonus = line.steps.flatMap((s) => s.completed).filter((t) => !picked.has(t.id));
    const where = line.steps[0]!.progress.task.location;
    return [
      `**${i + 1}. ${lineName(line.steps)}** · +${fmt(xp)} XP · ${formatMinutes(minutes)}`,
      `-# Σ ${fmt(total.xp)} XP · ${formatMinutes(total.minutes)}${where ? ` · ${where}` : ''}${bonus.length ? ` · also completes ${bonus.map((t) => t.name).join(', ')}` : ''}`,
    ].join('\n');
  });
}

export interface TargetView {
  /** What the user asked for, for the header. */
  ask: { kind: 'xp'; xp: number } | { kind: 'level'; level: number };
  now?: number;
  isLinked?: boolean;
}

export function targetEmbed(playerName: string, profile: NormalizedProfile, plan: TargetPlan, page: number, view: TargetView): EmbedBuilder {
  const lines = targetLines(plan);
  const pages = Math.max(1, Math.ceil(lines.length / TARGET_PAGE_SIZE));
  const start = page * TARGET_PAGE_SIZE;
  const { experience, level } = profile.leveling;
  const reachedLevel = Math.floor((experience + plan.xp) / 100);
  const ask = view.ask.kind === 'level' ? `Level ${view.ask.level} (+${fmt(plan.target)} XP)` : `+${fmt(plan.target)} XP`;

  const head = [
    `**Target ${ask}** · level ${level} → ${reachedLevel}`,
    plan.picks.length
      ? `Plan: **${fmt(plan.xp)} XP** · ${formatMinutes(plan.minutes)} · ${fmt(plan.picks.length)} task${plan.picks.length === 1 ? '' : 's'}`
      : 'No eligible task can be planned right now.',
    !plan.reached && !plan.capped && plan.picks.length
      ? `Only **${fmt(plan.xp)} XP** can be reached with eligible tasks, so this plan stops there.` : '',
    plan.capped ? `This target needs more than ${fmt(plan.picks.length)} tasks; the plan stops there.` : '',
  ].filter(Boolean);

  const r = plan.rateSources;
  const rates = [r.session && `${r.session} from your sessions`, r.override && `${r.override} your overrides`, r.fixed && `${r.fixed} fixed`, r.default && `${r.default} defaults`]
    .filter(Boolean).join(', ');
  const notes = [
    plan.picks.length ? `XP is exact (fixed rewards). Time adds up end to end: ${formatMinutes([plan.minutes[0], plan.minutes[0]])} if every rate is at its best, ${formatMinutes([plan.minutes[1], plan.minutes[1]])} at its worst.` : '',
    rates ? `Rates: ${rates}.` : '',
    plan.estimatedSteps ? `${plan.estimatedSteps} step(s) use estimated progress (bestiary) and may already be done in game.` : '',
    plan.trimmed ? `Left out ${plan.trimmed} task(s) the target didn't need.` : '',
  ].filter(Boolean);

  return new EmbedBuilder()
    .setTitle(`SkyBlock XP target · ${playerName} · ${profile.cuteName}`)
    .setDescription([...head, '', ...lines.slice(start, start + TARGET_PAGE_SIZE), '', ...notes.map((n) => `-# ${n}`)].join('\n'))
    .setFooter({
      text: [profile.cuteName, `data ${dataAge(profile.fetchedAt, view.now)}`, 'monetary tasks excluded', view.isLinked ? 'your overrides applied' : '', `page ${page + 1}/${pages}`]
        .filter(Boolean).join(' · '),
    });
}

/** Number of lines (runs of steps), for the Prev/Next buttons. */
export const targetLineCount = (plan: TargetPlan) => group(plan).length;
