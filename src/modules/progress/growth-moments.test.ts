// Growth Moments: stars, finished activities and milestones, newest first.
import { describe, expect, test } from 'vitest';
import { buildGrowthMoments, type MomentCompletion, type MomentStar } from './growth-moments.js';

const star = (id: string, iso: string, role = 'teacher'): MomentStar => ({
  id,
  area: 'communication',
  description: 'Spoke up in class.',
  authorRole: role,
  authorName: role === 'teacher' ? 'Sunita Rao' : 'Priya Ahluwalia',
  createdAt: new Date(iso),
});
const done = (id: string, iso: string): MomentCompletion => ({ id, activityTitle: 'Daily journal', completedAt: new Date(iso) });

describe('buildGrowthMoments', () => {
  test('nothing yet, no moments', () => {
    expect(buildGrowthMoments([], [])).toEqual([]);
  });

  test('a star keeps the giver’s words and says whether it came from school or home', () => {
    const [school, home] = buildGrowthMoments([star('a', '2026-10-02T04:00:00Z'), star('b', '2026-10-01T04:00:00Z', 'parent')], []).filter(
      (m) => m.kind === 'star',
    );
    expect(school).toMatchObject({ kind: 'star', title: 'A star from school', detail: 'Spoke up in class.', givenBy: { fullName: 'Sunita Rao', role: 'teacher' } });
    expect(home).toMatchObject({ title: 'A star from home', givenBy: { role: 'parent' } });
  });

  test('a finished activity names the activity and nothing of the answer', () => {
    const [moment] = buildGrowthMoments([], [done('c1', '2026-10-03T04:00:00Z')]);
    expect(moment).toEqual({
      id: 'activity-c1',
      kind: 'activity',
      title: 'Finished “Daily journal”',
      detail: null,
      area: null,
      givenBy: null,
      occurredAt: '2026-10-03T04:00:00.000Z',
    });
  });

  test('the first star and the first activity are milestones, dated when they happened', () => {
    const moments = buildGrowthMoments([star('a', '2026-10-02T04:00:00Z')], [done('c1', '2026-10-03T04:00:00Z')]);
    const milestones = moments.filter((m) => m.kind === 'milestone');
    expect(milestones.map((m) => [m.title, m.occurredAt])).toEqual([
      ['First activity finished', '2026-10-03T04:00:00.000Z'],
      ['Their first star!', '2026-10-02T04:00:00.000Z'],
    ]);
  });

  test('the fifth star is a milestone dated at the fifth star, and the fourth is not', () => {
    const stars = [1, 2, 3, 4, 5].map((n) => star(`s${n}`, `2026-10-0${n}T04:00:00Z`));
    expect(buildGrowthMoments(stars.slice(0, 4), []).some((m) => m.title === '5 stars earned')).toBe(false);
    const fifth = buildGrowthMoments(stars, []).find((m) => m.title === '5 stars earned');
    expect(fifth?.occurredAt).toBe('2026-10-05T04:00:00.000Z');
  });

  test('newest first across all kinds', () => {
    const moments = buildGrowthMoments([star('a', '2026-10-02T04:00:00Z')], [done('c1', '2026-10-05T04:00:00Z'), done('c2', '2026-10-01T04:00:00Z')]);
    const times = moments.map((m) => m.occurredAt);
    expect(times).toEqual([...times].sort().reverse());
  });
});
