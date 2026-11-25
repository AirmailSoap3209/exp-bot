import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProfilesResponse } from '../../src/hypixel/client.js';
import { normalizeProfile, pickProfile, type SkillsResource } from '../../src/profile/normalize.js';
import { buildCatalogue, loadCatalogue } from '../../src/tasks/catalogue.js';
import { decideTick, evaluateProgress, evaluateTask } from '../../src/tasks/progress.js';
import type { Meta, Task } from '../../src/tasks/types.js';

const catalogue = loadCatalogue();
const read = <T>(p: string): T => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')) as T;
const skills = read<SkillsResource>('../fixtures/resource-skills.json');
function profile(player: string, name?: string) {
  const { uuid, response } = read<{ uuid: string; response: ProfilesResponse }>(`../fixtures/profiles-${player}.json`);
  return normalizeProfile(pickProfile(response.profiles, name)!, uuid, skills, 0);
}
const lime = profile('floor7sweat', 'lime');
const ducksterr = profile('ducksterr_');

describe('SkyBlock Leveling categories (wiki SkyBlock_Levels/Tasks, 2026-11-24)', () => {
  const xpOf = (category: string, group?: string) =>
    (catalogue.byCategory.get(category) ?? []).filter((t) => !group || t.group?.startsWith(group)).reduce((n, t) => n + t.xp, 0);

  it.each([
    ['dragons', undefined, 200], ['kuudra', undefined, 300], ['arachne', undefined, 60], ['mythological', undefined, 100],
    ['hotm', 'hotm.tiers', 1175], ['hotm', 'hotm.nucleus', 200], ['garden', 'garden.jacob', 130], ['garden', 'garden.anita', 250],
    ['trophy_fishing', undefined, 1080], ['foraging_tasks', 'hotf', 725], ['foraging_tasks', 'safari', 220], ['rift', undefined, 800],
    ['quests', 'reputation', 150], ['events', 'events.spooky_brackets', 225], ['events', 'events.winter', 49],
    ['essence_shop', 'essence.crimson', 194], ['essence_shop', 'essence.diamond', 226], ['essence_shop', 'essence.forest', 171],
    ['essence_shop', 'essence.gold', 188], ['essence_shop', 'essence.spider', 126],
    ['exploration', 'harp', 236], ['exploration', 'dojo', 425],
  ] as const)('%s %s totals %i XP, as the wiki lists', (category, group, xp) => expect(xpOf(category, group)).toBe(xp));

  it('chains tiers and points ID tasks at the completed-task list', () => {
    const t = (id: string) => catalogue.byId.get(id)!;
    expect(t('kuudra.tiers.hot')).toMatchObject({ prerequisites: ['kuudra.tiers.none'], hypixelTaskId: 'KILL_KUUDRA_HOT', requires: { metric: 'task.KILL_KUUDRA_HOT', amount: 1 } });
    expect(t('dragons.superior.kill').prerequisites).toEqual([]);
    expect(t('trophy.gusher.gold')).toMatchObject({ requires: { metric: 'trophy.gusher_gold', amount: 1 }, hypixelTaskId: 'TROPHY_GUSHER_GOLD' });
    expect(t('dojo.belts.black')).toMatchObject({ hypixelTaskIdUnconfirmed: true, prerequisites: ['dojo.belts.brown'] });
    expect(t('hotm.tiers.tier5').requires).toEqual({ metric: 'hotm.xp', amount: 97000 });
  });
});

describe('new profile sections', () => {
  it('reads HotM/HotF XP, task counters, Jacob, trophy fish and the Rift', () => {
    expect(lime.skillTree).toEqual({ available: true, value: { hotmXp: expect.closeTo(147660.91, 1), hotfXp: 425988 } });
    expect(ducksterr.rift).toMatchObject({ available: true, value: { timecharms: 8 } });
    expect(lime.jacob.available).toBe(true);
    expect(lime.trophyFish.available).toBe(true);
    expect(lime.completions.available).toBe(true);
  });

  it('turns them into task status', () => {
    const P = new Map(evaluateProgress(catalogue, lime).progress.map((p) => [p.task.id, p]));
    expect(P.get('hotm.tiers.tier5')!.status).toBe('verified_complete'); // 147,660 >= 97,000
    expect(P.get('hotm.tiers.tier6')).toMatchObject({ status: 'verified_incomplete', remaining: expect.closeTo(197000 - 147660.91, 0) });
    expect(P.get('hotf.tiers.tier7')!.status).toBe('verified_complete'); // 425,988 >= 347,000
    expect(P.get('hotf.tiers.tier8')!.status).toBe('verified_incomplete');
    const D = new Map(evaluateProgress(catalogue, ducksterr).progress.map((p) => [p.task.id, p]));
    expect(D.get('rift.timecharms.charm8')!.status).toBe('verified_complete');
    expect(D.get('dragons.superior.kill')!.status).toBe('verified_complete');
  });
});

describe('task IDs', () => {
  const base: Task = {
    id: 'x', category: 'events', name: 'X', description: 'X', xp: 5, requires: { metric: 'task.SOME_TASK', amount: 1 }, prerequisites: [],
    activity: null, minutes: [1, 2], monetary: false, tracking: 'api', source: 's', hypixelTaskId: 'SOME_TASK',
  };

  it('a confirmed ID missing from the list is verified incomplete; present, verified complete', () => {
    expect(evaluateTask(base, lime, false).progress.status).toBe('verified_incomplete');
    const done = { ...lime, leveling: { ...lime.leveling, completedTasks: { available: true as const, value: new Set(['SOME_TASK']) } } };
    expect(evaluateTask(base, done, false).progress.status).toBe('verified_complete');
  });

  it('an unconfirmed ID missing from the list is only an estimate, and can be ticked', () => {
    const t = { ...base, hypixelTaskIdUnconfirmed: true };
    expect(evaluateTask(t, lime, false).progress).toMatchObject({ status: 'estimated', current: 0, remaining: 1 });
    expect(decideTick(t, lime)).toEqual({ ok: true });
    expect(evaluateTask(t, lime, true).progress.status).toBe('ticked');
  });

  it('the validator wants an ID for task.<ID> metrics, and the flag only with an ID', () => {
    const meta: Meta = {
      checked: 'x', guideCategories: [{ id: 'event', name: 'E', maxXp: null, wikiEstimate: null }],
      categories: [{ id: 'events', name: 'Events', status: 'v1', guide: 'event' }],
    };
    const { hypixelTaskId: _, ...noId } = base;
    expect(() => buildCatalogue(meta, [{ file: 'tasks/events.json', entries: [noId] }])).toThrow(/task\.<ID> metric needs a hypixelTaskId/);
    expect(() => buildCatalogue(meta, [{ file: 'tasks/events.json', entries: [{ ...noId, requires: { metric: 'm', amount: 1 }, hypixelTaskIdUnconfirmed: true }] }]))
      .toThrow(/hypixelTaskIdUnconfirmed must be true, and only on a task with a hypixelTaskId/);
  });
});
