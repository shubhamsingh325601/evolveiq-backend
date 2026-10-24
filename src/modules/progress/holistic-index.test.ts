// The EHI formula: pure functions, fixed dates.
import { describe, expect, test } from 'vitest';
import {
  buildHolisticIndex,
  dimensionScores,
  monthlyHistory,
  overallScore,
  pillarScore,
  schoolYearLabel,
  schoolYearStart,
  scoreAt,
  skillProfile,
  strengthsOf,
  yearlyHistory,
  type HolisticInputs,
  type Signal,
} from './holistic-index.js';

const NOW = new Date('2026-10-24T06:30:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const star = (area: Signal['area'], days = 1): Signal => ({ tone: 'positive', area, level: null, status: 'celebrated', at: daysAgo(days) });
const concern = (area: Signal['area'], level: Signal['level'] = 'moderate', days = 1, status: Signal['status'] = 'pending'): Signal => ({
  tone: 'concern',
  area,
  level,
  status,
  at: daysAgo(days),
});
const inputs = (signals: Signal[] = [], extra: Partial<HolisticInputs> = {}): HolisticInputs => ({
  signals,
  assigned: [],
  completions: [],
  ...extra,
});

describe('pillars', () => {
  test('a child nothing has been noticed about sits at the neutral 50 everywhere', () => {
    const scores = dimensionScores(inputs(), NOW);
    expect(scores.map((s) => s.score)).toEqual([50, 50, 50, 50, 50]);
    expect(overallScore(scores)).toBe(50);
  });

  test('stars lift the pillar their area feeds, and only that one', () => {
    const list = inputs([star('social'), star('social', 3)]);
    expect(pillarScore(list, 'character', NOW)).toBeGreaterThan(60);
    expect(pillarScore(list, 'education', NOW)).toBe(50);
    expect(pillarScore(list, 'wellbeing', NOW)).toBe(50);
  });

  test('a concern lowers it, a bigger Level lowers it more, and a reviewed one less', () => {
    const minor = pillarScore(inputs([concern('emotions', 'minor')]), 'wellbeing', NOW);
    const significant = pillarScore(inputs([concern('emotions', 'significant')]), 'wellbeing', NOW);
    const reviewed = pillarScore(inputs([concern('emotions', 'significant', 1, 'reviewed')]), 'wellbeing', NOW);
    expect(significant).toBeLessThan(minor);
    expect(minor).toBeLessThan(50);
    expect(reviewed).toBeGreaterThan(significant);
  });

  test('routines feed both physical and wellbeing', () => {
    const list = inputs([star('routines')]);
    expect(pillarScore(list, 'physical', NOW)).toBeGreaterThan(50);
    expect(pillarScore(list, 'wellbeing', NOW)).toBeGreaterThan(50);
  });

  test('older evidence counts for less', () => {
    const fresh = pillarScore(inputs([star('learning', 2)]), 'education', NOW);
    const old = pillarScore(inputs([star('learning', 200)]), 'education', NOW);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeGreaterThanOrEqual(50);
  });

  test('a flood of stars cannot push a pillar past 92 from observations alone', () => {
    const many = Array.from({ length: 200 }, () => star('behaviour', 0));
    expect(pillarScore(inputs(many), 'character', NOW)).toBeLessThanOrEqual(92);
  });

  test('an observation dated after the "as of" date is not counted yet', () => {
    expect(pillarScore(inputs([star('learning', -5)]), 'education', NOW)).toBe(50);
  });

  test('education follows how many of the set activities were finished', () => {
    const allDone = inputs([], { assigned: [daysAgo(10), daysAgo(9)], completions: [daysAgo(8), daysAgo(7)] });
    const noneDone = inputs([], { assigned: [daysAgo(10), daysAgo(9)] });
    expect(pillarScore(allDone, 'education', NOW)).toBe(58);
    expect(pillarScore(noneDone, 'education', NOW)).toBe(42);
  });

  test('skills rise with activities finished lately, up to 8 points', () => {
    const some = inputs([], { completions: [daysAgo(1), daysAgo(2), daysAgo(3)] });
    const lots = inputs([], { completions: Array.from({ length: 30 }, (_, i) => daysAgo(i)) });
    expect(pillarScore(some, 'skills', NOW)).toBe(53);
    expect(pillarScore(lots, 'skills', NOW)).toBe(58);
  });
});

describe('history', () => {
  test('school years run April to March', () => {
    expect(schoolYearStart('2026-10-24')).toBe(2026);
    expect(schoolYearStart('2026-03-31')).toBe(2025);
    expect(schoolYearStart('2026-04-01')).toBe(2026);
    expect(schoolYearLabel(2026)).toBe('2026–27');
  });

  test('one entry per school year, the current one flagged and scored as of now', () => {
    const list = inputs([star('learning', 300), star('learning', 5)]);
    const years = yearlyHistory(list, NOW, new Date('2025-06-01T00:00:00Z'));
    expect(years.map((y) => y.schoolYear)).toEqual(['2025–26', '2026–27']);
    expect(years.map((y) => y.isCurrent)).toEqual([false, true]);
    expect(years.every((y) => y.grade === null)).toBe(true);
    expect(years[1]!.score).toBe(scoreAt(list, NOW));
  });

  test('the monthly trend covers six months, or fewer for a new student', () => {
    const list = inputs([star('learning', 100), star('social', 40), star('emotions', 3)]);
    const six = monthlyHistory(list, NOW, new Date('2026-01-01T00:00:00Z'));
    expect(six.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(six.at(-1)!.score).toBe(scoreAt(list, NOW));
    expect(monthlyHistory(list, NOW, new Date('2026-09-10T00:00:00Z')).map((m) => m.month)).toEqual(['2026-09', '2026-10']);
  });

  test('more good moments over time make the trend climb', () => {
    const list = inputs([star('learning', 90), star('social', 60), star('emotions', 30), star('behaviour', 5)]);
    const months = monthlyHistory(list, NOW, new Date('2026-01-01T00:00:00Z'));
    expect(months.at(-1)!.score).toBeGreaterThan(months[0]!.score);
  });
});

describe('skills and strengths', () => {
  test('the profile lists only the areas the child has been noticed in, strongest first', () => {
    const profile = skillProfile(inputs([star('social'), star('social', 2), concern('physical', 'minor')]), NOW);
    expect(profile.map((s) => s.skill)).toEqual(['Teamwork', 'Active & healthy']);
    expect(profile[0]!.score).toBeGreaterThan(profile[1]!.score);
  });

  test('strengths are the areas with the most good noticed', () => {
    expect(strengthsOf(inputs([star('communication'), star('communication', 2), star('social')]), NOW)).toEqual(['Communication', 'Teamwork']);
  });

  test('steady effort with activities is itself a strength', () => {
    const done = inputs([], { completions: Array.from({ length: 6 }, (_, i) => daysAgo(i)) });
    expect(strengthsOf(done, NOW)).toEqual(['Finishing what they start']);
  });

  test('nothing noticed, no strengths and no skills', () => {
    expect(strengthsOf(inputs(), NOW)).toEqual([]);
    expect(skillProfile(inputs(), NOW)).toEqual([]);
  });
});

describe('insights', () => {
  test('one per pillar, and an empty child gets honest "not enough yet" insights', () => {
    const index = buildHolisticIndex(inputs(), NOW, new Date('2026-09-01T00:00:00Z'));
    expect(index.insights).toHaveLength(5);
    for (const insight of index.insights) {
      expect(insight.confidence).toBe('low');
      expect(insight.trend).toBe('steady');
      expect(insight.title).toMatch(/^Still getting to know/);
    }
  });

  test('recent good moments make a pillar "growing", with the reason and the factors', () => {
    const list = inputs([star('social', 2), star('behaviour', 4), star('social', 6)]);
    const character = buildHolisticIndex(list, NOW, new Date('2026-09-01T00:00:00Z')).insights.find((i) => i.dimension === 'character')!;
    expect(character.trend).toBe('up');
    expect(character.title).toBe('Character is growing');
    expect(character.factors).toEqual(['3 good things noticed in the last 3 months']);
    expect(character.confidence).toBe('medium');
    expect(character.why).toContain('stronger');
  });

  test('a fresh concern after a good stretch reads as "could use some support", gently', () => {
    const list = inputs([star('emotions', 40), concern('emotions', 'significant', 2), concern('emotions', 'moderate', 3)]);
    const wellbeing = buildHolisticIndex(list, NOW, new Date('2026-09-01T00:00:00Z')).insights.find((i) => i.dimension === 'wellbeing')!;
    expect(wellbeing.trend).toBe('down');
    expect(wellbeing.title).toBe('Wellbeing could use some support');
  });

  test('parent-safe: no insight, factor, step or strength ever mentions a concern, Level or review', () => {
    const list = inputs([star('emotions', 40), concern('emotions', 'significant', 2), concern('behaviour', 'minor', 3, 'reviewed')]);
    const index = buildHolisticIndex(list, NOW, new Date('2026-09-01T00:00:00Z'));
    const text = JSON.stringify([index.insights, index.playbook, index.strengths, index.evidence]).toLowerCase();
    for (const word of ['concern', 'significant', 'moderate', 'minor', 'reviewed', 'psycholog', 'counsel', 'diagnos']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('the whole index', () => {
  const list = inputs([star('learning', 3), star('social', 8), concern('emotions', 'minor', 20)], {
    assigned: [daysAgo(30), daysAgo(20)],
    completions: [daysAgo(25), daysAgo(15)],
  });
  const index = buildHolisticIndex(list, NOW, new Date('2026-09-01T00:00:00Z'));

  test('the score is the mean of the five pillars', () => {
    expect(index.score).toBe(overallScore(index.dimensions));
    expect(index.dimensions.map((d) => d.dimension)).toEqual(['education', 'skills', 'physical', 'wellbeing', 'character']);
  });

  test('every score stays inside 0–100', () => {
    for (const n of [index.score, ...index.dimensions.map((d) => d.score), ...index.monthly.map((m) => m.score), ...index.history.map((h) => h.score)]) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(100);
    }
  });

  test('evidence counts the stars and the finished activities', () => {
    expect(index.evidence).toEqual({ stars: 2, activitiesCompleted: 2 });
  });

  test('the playbook always ends by pointing at stars', () => {
    expect(index.playbook.at(-1)).toContain('add it as a star');
    expect(index.playbook.length).toBeLessThanOrEqual(4);
  });
});
