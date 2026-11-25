import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { taskEmbed } from '../../src/commands/taskDetail.js';
import { estimateTask } from '../../src/estimate/estimate.js';
import { loadRates } from '../../src/estimate/rates.js';
import type { ProfilesResponse } from '../../src/hypixel/client.js';
import { categoryView, metricLabel, sourceName } from '../../src/optimizer/category.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import { loadCatalogue } from '../../src/tasks/catalogue.js';
import { evaluateProgress } from '../../src/tasks/progress.js';
import { activities } from '../../src/tasks/search.js';

const catalogue = loadCatalogue();
const book = loadRates();
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>('../fixtures/profiles-floor7sweat.json');
const lime = normalizeProfile(pickProfile(response.profiles, 'lime')!, uuid, read<SkillsResource>('../fixtures/resource-skills.json'), 0);
const progress = evaluateProgress(catalogue, lime).progress;
const P = new Map(progress.map((p) => [p.task.id, p]));

describe('categoryView', () => {
  it('lists only that category, one next tier per source, quickest first', () => {
    const v = categoryView(catalogue, progress, lime, { book }, 'bestiary');
    const ranked = v.result.ranked;
    expect(ranked.length).toBeGreaterThan(100);
    expect(ranked.every((r) => r.progress.task.category === 'bestiary')).toBe(true);
    const groups = ranked.map((r) => r.progress.task.group);
    expect(new Set(groups).size).toBe(groups.length);
    const mids = ranked.map((r) => r.estimate.midMinutes);
    expect(mids).toEqual([...mids].sort((a, b) => a - b));
    expect(v.result.dropped.excluded).toBe(0);
    expect(v.summary?.earned).toBe(150);
  });

  it('shows minions even though they are left out of rankings by default, and keeps cross-category prerequisites', () => {
    const v = categoryView(catalogue, progress, lime, { book }, 'minions');
    expect(v.result.ranked.length).toBeGreaterThan(0);
    for (const r of v.result.ranked) {
      for (const pre of r.progress.task.prerequisites) {
        const st = P.get(pre)!.status;
        expect(['verified_complete', 'ticked', 'estimated']).toContain(st);
      }
    }
  });
});

describe('categoryView with excluded sources', () => {
  it('hides them and counts them', () => {
    const all = categoryView(catalogue, progress, lime, { book }, 'skills');
    const hide = all.result.ranked[0]!.progress.task.group!;
    const v = categoryView(catalogue, progress, lime, { book }, 'skills', new Set([hide]));
    expect(v.hiddenSources).toBe(1);
    expect(v.result.ranked.some((r) => r.progress.task.group === hide)).toBe(false);
    expect(all.hiddenSources).toBe(0);
  });

  it('notes excluded tasks in the task detail', () => {
    const task = catalogue.byId.get('slayer.zombie.level8')!;
    const json = taskEmbed(task, catalogue, book, { playerName: 'x', profile: lime, progress: P, excludedBy: 'source', now: 0 }).toJSON();
    expect(json.fields?.find((f) => f.name === 'Excluded')?.value).toContain('/xp include source:');
  });
});

describe('readable names', () => {
  it.each([
    ['Combat level 43', 'Combat'],
    ['Revenant Horror Slayer level 8', 'Revenant Horror Slayer'],
    ['Wheat collection X', 'Wheat collection'],
    ['Crypt Ghoul Bestiary IV', 'Crypt Ghoul Bestiary'],
    ['Defeat Revenant Horror V', 'Defeat Revenant Horror'],
    ['Fairy Soul exchange 38', 'Fairy Soul'],
  ])('sourceName(%j) = %j', (name, expected) => expect(sourceName(name)).toBe(expected));

  it('labels metrics and activities for messages', () => {
    expect(metricLabel(catalogue, 'skills.combat.xp')).toBe('Combat');
    expect(metricLabel(catalogue, 'collections.ROTTEN_FLESH')).toBe('Rotten Flesh collection');
    expect(metricLabel(catalogue, 'nope')).toBe('nope');
    expect(activities(catalogue).find((a) => a.id === 'slayer.zombie')?.label).toBe('Revenant Horror Slayer');
  });
});

describe('taskEmbed', () => {
  const task = catalogue.byId.get('slayer.zombie.level8')!;

  it('shows status, progress, estimate, prerequisites and next tier for the linked profile', () => {
    const p = P.get(task.id)!;
    const json = taskEmbed(task, catalogue, book, { playerName: 'Floor7Sweat', profile: lime, progress: P, estimate: estimateTask(p, lime, { book }), now: 0 }).toJSON();
    const field = (n: string) => json.fields?.find((f) => f.name === n)?.value ?? '';
    expect(json.title).toBe('Revenant Horror Slayer level 8');
    expect(field('Status')).toContain('Verified incomplete');
    expect(field('Status')).toContain('104,305/400,000 slayer XP · 295,695 left');
    expect(field('Estimate')).toMatch(/mid bracket \(slayer\.zombie 7\)/);
    expect(field('Prerequisites')).toBe('• Revenant Horror Slayer level 7 · verified complete');
    expect(field('Next tier')).toBe('Revenant Horror Slayer level 9 (+150 XP)');
    expect(field('Category')).toBe('Slayer · tier 8 of 9');
    expect(json.footer?.text).toBe('Floor7Sweat · Lime · data 0s old · task slayer.zombie.level8');
    for (const f of json.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
  });

  it('falls back to task data only without a link', () => {
    const json = taskEmbed(catalogue.byId.get('catacombs.master7')!, catalogue, book).toJSON();
    expect(json.fields?.some((f) => f.name === 'Status')).toBe(false);
    expect(json.fields?.find((f) => f.name === 'Details')?.value).toContain('COMPLETE_MASTER_CATACOMBS7');
    expect(json.footer?.text).toContain('Not linked');
  });
});
