import { describe, expect, test } from 'vitest';
import { Role } from '../../shared/rbac/index.js';
import { buildFeed, countUnread, FEED_LIMIT, type FeedInputs } from './notifications.js';

const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T06:00:00.000Z`);
const asha = { id: 's1', fullName: 'Asha Rao' };

const inputs: FeedInputs = {
  stars: [{ id: 'o1', at: at(20), area: 'social', student: asha }],
  assignments: [{ id: 'a1', at: at(21), activityTitle: 'Feelings check', student: asha }],
  completions: [{ id: 'c1', at: at(22), activityTitle: 'Feelings check', student: asha }],
  pendingConcerns: { count: 2, newestAt: at(23) },
};

describe('feed', () => {
  test('a student hears about their stars and new activities, in the second person', () => {
    const feed = buildFeed({ role: Role.Student }, inputs);
    expect(feed.map((f) => f.kind)).toEqual(['activity_assigned', 'star']);
    expect(feed.find((f) => f.kind === 'star')?.title).toBe('You earned a star');
  });

  test('a parent hears about the child by first name, including finished activities', () => {
    const feed = buildFeed({ role: Role.Parent }, inputs);
    expect(feed.map((f) => f.kind)).toEqual(['activity_finished', 'activity_assigned', 'star']);
    expect(feed[0]?.title).toBe('Asha finished an activity');
    expect(JSON.stringify(feed)).not.toMatch(/concern|review|level/i);
  });

  test('a teacher hears when students finish; a psychologist about the review queue', () => {
    expect(buildFeed({ role: Role.Teacher }, inputs).map((f) => f.kind)).toEqual(['activity_finished']);
    const psych = buildFeed({ role: Role.Psychologist }, inputs);
    expect(psych).toHaveLength(1);
    expect(psych[0]).toMatchObject({ kind: 'review_queue', title: '2 observations are waiting for review' });
  });

  test('students and parents never see the review queue', () => {
    for (const role of [Role.Student, Role.Parent]) {
      expect(buildFeed({ role }, inputs).some((f) => f.kind === 'review_queue')).toBe(false);
    }
  });

  test('stays within the limit, newest first', () => {
    const many: FeedInputs = {
      ...inputs,
      stars: Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, at: new Date(2026, 0, 1, 0, i), area: 'social', student: asha })),
    };
    const feed = buildFeed({ role: Role.Student }, many);
    expect(feed).toHaveLength(FEED_LIMIT);
    expect(feed[0]?.at.getTime()).toBeGreaterThanOrEqual(feed[1]?.at.getTime() ?? 0);
  });
});

describe('unread', () => {
  const items = [{ at: at(20) }, { at: at(22) }];
  test('everything is unread before the feed was ever opened', () => expect(countUnread(items, null)).toBe(2));
  test('only newer items are unread afterwards', () => expect(countUnread(items, at(21))).toBe(1));
  test('nothing is unread once seen after the newest', () => expect(countUnread(items, at(23))).toBe(0));
});
