import { SLAYER_BOSSES, SKILLS, type SkillId, type SlayerBoss, type NormalizedProfile } from '../profile/types.js';
import { BRACKET_NAMES, type Bracket, type BracketConfig } from './types.js';

export interface BracketResult {
  bracket: Bracket;
  /** False when none of the inputs had data, so the bracket is an assumption. */
  known: boolean;
  /** e.g. "combat 42, slayer 7" */
  detail: string;
}

/** The level an input names, or undefined when the profile doesn't show it. */
export function inputLevel(input: string, p: NormalizedProfile): number | undefined {
  const [kind, which] = input.split('.');
  if (kind === 'skill' && SKILLS.includes(which as SkillId)) return p.skills.available ? p.skills.value[which as SkillId].level : undefined;
  if (kind === 'slayer') {
    if (!p.slayer.available) return undefined;
    if (which === 'highest') return Math.max(...SLAYER_BOSSES.map((b) => p.slayer.available ? p.slayer.value[b].level : 0));
    return SLAYER_BOSSES.includes(which as SlayerBoss) ? p.slayer.value[which as SlayerBoss].level : undefined;
  }
  if (kind === 'catacombs') return p.catacombs.available ? p.catacombs.value.level.level : undefined;
  return undefined;
}

function cutoff(input: string, cfg: BracketConfig): [number, number] {
  const c = cfg.cutoffs[input] ?? cfg.cutoffs[input.split('.')[0]!];
  if (!c) throw new Error(`No bracket cut-off for ${input} in data/rates/brackets.json`);
  return c;
}

const fromLevel = (level: number, [mid, late]: [number, number]): Bracket => (level >= late ? 'late' : level >= mid ? 'mid' : 'early');

/** Picks the bracket for a rate's bracketBy: a group from brackets.json, or a single input. */
export function resolveBracket(bracketBy: string, p: NormalizedProfile, cfg: BracketConfig): BracketResult {
  const group = cfg.groups[bracketBy];
  const inputs = group?.inputs ?? [bracketBy];
  const known: { input: string; level: number; bracket: Bracket }[] = [];
  for (const input of inputs) {
    const level = inputLevel(input, p);
    if (level !== undefined) known.push({ input, level, bracket: fromLevel(level, cutoff(input, cfg)) });
  }
  if (!known.length) return { bracket: 'early', known: false, detail: `no data for ${inputs.join(', ')}` };
  const idx = known.map((k) => BRACKET_NAMES.indexOf(k.bracket));
  const pick = (group?.combine ?? 'min') === 'min' ? Math.min(...idx) : Math.max(...idx);
  return {
    bracket: BRACKET_NAMES[pick]!,
    known: true,
    detail: known.map((k) => `${k.input.replace(/^skill\./, '').replace('.highest', '')} ${k.level}`).join(', '),
  };
}
