// The monthly-summary template: plain sentences built only from counts and growth-area names.
import { describe, expect, test } from 'vitest';
import { buildSummaryText } from './progress.service.js';

const facts = { name: 'Asha', month: '2026-10', isCurrentMonth: false, completed: 0, activeDays: 0, longestStreak: 0, growthAreas: [] as string[] };

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
});
