// Growth Moments: the child's good days as a timeline — stars (teacher appreciation and things
// noticed at home), activities finished, and the milestones along the way ("5 stars", "10
// activities"). Pure functions; the service fetches the rows. Everything here is parent-safe: a
// star is a positive observation, which has no Level or review, and an activity moment names
// the activity but never the student's answer.
import type { ObservationArea } from '../../generated/prisma/enums.js';

export type GrowthMomentKind = 'star' | 'activity' | 'milestone';

export interface GrowthMoment {
  id: string;
  kind: GrowthMomentKind;
  title: string;
  /** The giver's own words for a star; null otherwise. */
  detail: string | null;
  area: ObservationArea | null;
  givenBy: { fullName: string; role: 'parent' | 'teacher' } | null;
  occurredAt: string;
}

export interface MomentStar {
  id: string;
  area: ObservationArea;
  description: string;
  authorRole: string;
  authorName: string;
  createdAt: Date;
}

export interface MomentCompletion {
  id: string;
  activityTitle: string;
  completedAt: Date;
}

/** The counts that earn a milestone, per kind of thing. */
export const STAR_MILESTONES = [1, 5, 10, 25, 50, 100] as const;
export const ACTIVITY_MILESTONES = [1, 10, 25, 50, 100] as const;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function starMilestoneTitle(n: number): string {
  return n === 1 ? 'Their first star!' : `${n} stars earned`;
}

function activityMilestoneTitle(n: number): string {
  return n === 1 ? 'First activity finished' : `${n} ${plural(n, 'activity', 'activities')} finished`;
}

/** Milestones for the nth item (oldest first) of a series: dated when the nth was reached. */
function milestonesFor(
  prefix: string,
  dates: readonly Date[],
  steps: readonly number[],
  titleOf: (n: number) => string,
): GrowthMoment[] {
  return steps.flatMap((n) => {
    const reached = dates[n - 1];
    return reached
      ? [{ id: `${prefix}-${n}`, kind: 'milestone' as const, title: titleOf(n), detail: null, area: null, givenBy: null, occurredAt: reached.toISOString() }]
      : [];
  });
}

/** All of a child's moments, newest first. */
export function buildGrowthMoments(stars: readonly MomentStar[], completions: readonly MomentCompletion[]): GrowthMoment[] {
  const starMoments: GrowthMoment[] = stars.map((s) => ({
    id: `star-${s.id}`,
    kind: 'star',
    title: s.authorRole === 'teacher' ? 'A star from school' : 'A star from home',
    detail: s.description,
    area: s.area,
    givenBy: { fullName: s.authorName, role: s.authorRole === 'parent' ? 'parent' : 'teacher' },
    occurredAt: s.createdAt.toISOString(),
  }));
  const activityMoments: GrowthMoment[] = completions.map((c) => ({
    id: `activity-${c.id}`,
    kind: 'activity',
    title: `Finished “${c.activityTitle}”`,
    detail: null,
    area: null,
    givenBy: null,
    occurredAt: c.completedAt.toISOString(),
  }));

  const oldestFirst = <T extends { createdAt?: Date; completedAt?: Date }>(items: readonly T[]) =>
    items.map((i) => (i.createdAt ?? i.completedAt) as Date).sort((a, b) => a.getTime() - b.getTime());
  const milestones = [
    ...milestonesFor('milestone-stars', oldestFirst(stars), STAR_MILESTONES, starMilestoneTitle),
    ...milestonesFor('milestone-activities', oldestFirst(completions), ACTIVITY_MILESTONES, activityMilestoneTitle),
  ];

  return [...starMoments, ...activityMoments, ...milestones].sort(
    (a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id),
  );
}
