import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../src/tasks/catalogue.js';
import { activities, findSource, findTask, searchActivities, searchSources, searchTasks, sources } from '../../src/tasks/search.js';

const catalogue = loadCatalogue();

describe('task search', () => {
  it('matches word starts in any order, keeping each source\'s tiers together, lowest first', () => {
    const r = searchTasks(catalogue.tasks, 'ghoul best').map((c) => c.value);
    expect(searchTasks(catalogue.tasks, 'ghoul best')[0]).toEqual({ name: 'Crypt Ghoul Bestiary I (+1 XP)', value: 'bestiary.hub.crypt_ghoul.tier1' });
    expect(r.slice(0, 3)).toEqual(['bestiary.hub.crypt_ghoul.tier1', 'bestiary.hub.crypt_ghoul.tier2', 'bestiary.hub.crypt_ghoul.tier3']);
    expect(r.every((v) => /^bestiary\.hub\.(crypt|golden)_ghoul\./.test(v))).toBe(true);
  });

  it('finds tasks by ID too', () => {
    expect(searchTasks(catalogue.tasks, 'catacombs.master7')[0]?.value).toBe('catacombs.master7');
  });

  it('respects Discord limits: 25 choices, 100-char names', () => {
    const r = searchTasks(catalogue.tasks, '');
    expect(r).toHaveLength(25);
    for (const c of searchTasks(catalogue.tasks, 'a')) expect(c.name.length).toBeLessThanOrEqual(100);
  });

  it('returns nothing for nonsense', () => expect(searchTasks(catalogue.tasks, 'qqqzzz')).toEqual([]));

  it('resolves typed input by ID or exact name', () => {
    expect(findTask(catalogue, 'slayer.zombie.tier5')?.name).toBe('Defeat Revenant Horror V');
    expect(findTask(catalogue, 'defeat revenant horror v')?.id).toBe('slayer.zombie.tier5');
    expect(findTask(catalogue, 'nope')).toBeUndefined();
  });
});

describe('activity search', () => {
  it('lists each activity once and finds it by label', () => {
    const all = activities(catalogue);
    expect(new Set(all.map((a) => a.id)).size).toBe(all.length);
    expect(all.find((a) => a.id === 'skill.combat')?.label).toBe('Combat');
    expect(searchActivities(catalogue, 'skill combat')[0]?.value).toBe('skill.combat');
  });
});

describe('source search', () => {
  it('has one non-monetary source per group, with unique labels', () => {
    const all = sources(catalogue);
    expect(all.length).toBe(new Set(all.map((s) => s.id)).size);
    expect(new Set(all.map((s) => s.label)).size).toBe(all.length);
    expect(all.find((s) => s.id === 'bestiary.catacombs.bat')?.label).toBe('Bat Bestiary · Catacombs');
    const wheat = all.find((s) => s.label === 'Wheat collection')!;
    expect(wheat.tiers).toBe(catalogue.tasks.filter((t) => t.group === wheat.id).length);
  });

  it('autocompletes and resolves typed input by ID, label or a task in it', () => {
    expect(searchSources(catalogue, 'revenant slayer')[0]?.value).toBe('slayer.zombie.level');
    expect(searchSources(catalogue, 'revenant', (s) => s.id !== 'slayer.zombie.level').map((c) => c.value)).not.toContain('slayer.zombie.level');
    for (const c of searchSources(catalogue, '')) expect(c.name.length).toBeLessThanOrEqual(100);
    expect(findSource(catalogue, 'skills.farming')?.label).toBe('Farming');
    expect(findSource(catalogue, 'wheat collection')?.category).toBe('collections');
    expect(findSource(catalogue, 'slayer.zombie.tier5')?.id).toBe('slayer.zombie.tier');
    expect(findSource(catalogue, 'nope')).toBeUndefined();
  });
});
