// The monthly-summary template: plain sentences built only from counts and growth-area names.
// And the star mapper: what a star shows, copied field by field.
import { describe, expect, test } from 'vitest';
import type { StarRecord } from './progress.repository.js';
import { buildSummaryText, toStarDto } from './progress.service.js';

const facts = {
  name: 'Asha',
  month: '2026-10',
  isCurrentMonth: false,
  completed: 0,
  activeDays: 0,
  longestStreak: 0,
  stars: 0,
  growthAreas: [] as string[],
};

describe('buildSummaryText', () => {
  test('finished month, nothing done', () => {
    expect(buildSummaryText(facts)).toBe('Asha did not complete any activities in October 2026.');
  });

  test('current month, nothing done yet', () => {
    expect(buildSummaryText({ ...facts, isCurrentMonth: true })).toBe('Asha has not completed any activities yet in October 2026.');
  });

  test('finished month with activity, a streak and growth areas', () => {
    expect(
      buildSummaryText({ ...facts, completed: 12, activeDays: 8, longestStreak: 4, growthAreas: ['Managing feelings', 'Confidence & self-esteem', 'Self-control'] }),
    ).toBe(
      'In October 2026, Asha completed 12 activities on 8 different days. Their longest streak was 4 days in a row. ' +
        'Areas Asha is working on: Managing feelings, Confidence & self-esteem and Self-control.',
    );
  });

  test('current month, singular forms, no streak sentence below 2 days', () => {
    expect(buildSummaryText({ ...facts, isCurrentMonth: true, completed: 1, activeDays: 1, longestStreak: 1, growthAreas: ['Self-control'] })).toBe(
      'So far in October 2026, Asha has completed 1 activity on 1 day. Areas Asha is working on: Self-control.',
    );
  });

  test('two growth areas are joined with "and"', () => {
    expect(buildSummaryText({ ...facts, growthAreas: ['A', 'B'] })).toBe('Asha did not complete any activities in October 2026. Areas Asha is working on: A and B.');
  });

  test('stars come before what is being worked on', () => {
    expect(buildSummaryText({ ...facts, isCurrentMonth: true, completed: 2, activeDays: 2, stars: 3, growthAreas: ['Self-control'] })).toBe(
      'So far in October 2026, Asha has completed 2 activities on 2 different days. Asha has earned 3 stars this month. ' +
        'Areas Asha is working on: Self-control.',
    );
    expect(buildSummaryText({ ...facts, stars: 1 })).toBe('Asha did not complete any activities in October 2026. Asha earned 1 star that month.');
  });
});

describe('toStarDto', () => {
  const record: StarRecord = {
    id: '11111111-1111-4111-8111-111111111111',
    studentId: '33333333-3333-4333-8333-333333333333',
    area: 'communication',
    description: 'Told the whole class about the museum trip, clearly and calmly.',
    authorRole: 'teacher',
    createdAt: new Date('2026-10-21T04:30:00.000Z'),
    author: { fullName: 'Sunita Rao' },
  };

  test('exactly what a star shows: the words, the area and who gave it', () => {
    expect(toStarDto(record)).toEqual({
      id: record.id,
      studentId: record.studentId,
      area: 'communication',
      description: 'Told the whole class about the museum trip, clearly and calmly.',
      givenBy: { fullName: 'Sunita Rao', role: 'teacher' },
      createdAt: '2026-10-21T04:30:00.000Z',
    });
  });

  test('a parent gives a star as a parent', () => {
    expect(toStarDto({ ...record, authorRole: 'parent', author: { fullName: 'Priya Ahluwalia' } }).givenBy).toEqual({
      fullName: 'Priya Ahluwalia',
      role: 'parent',
    });
  });
});
