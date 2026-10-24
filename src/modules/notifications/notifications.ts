// Pure rules for the notification feed. No HTTP, no SQL.
//
// The feed is derived from what already happened (stars, assignments, completions, the review
// queue), so there is nothing to keep in sync and nothing to lose. Only the moment a user last
// opened it is stored, which is what "unread" means.
import { Role, type Actor } from '../../shared/rbac/index.js';
import { OBSERVATION_AREA_LABELS, type ObservationArea } from '../observations/observation-options.js';

export type NotificationKind = 'star' | 'activity_assigned' | 'activity_finished' | 'review_queue';

export interface FeedStudent {
  readonly id: string;
  readonly fullName: string;
}

export interface FeedStar {
  readonly id: string;
  readonly at: Date;
  readonly area: ObservationArea;
  readonly student: FeedStudent;
}

export interface FeedAssignment {
  readonly id: string;
  readonly at: Date;
  readonly activityTitle: string;
  readonly student: FeedStudent;
}

export interface FeedCompletion {
  readonly id: string;
  readonly at: Date;
  readonly activityTitle: string;
  readonly student: FeedStudent;
}

export interface FeedInputs {
  readonly stars: readonly FeedStar[];
  readonly assignments: readonly FeedAssignment[];
  readonly completions: readonly FeedCompletion[];
  /** Concerns waiting for a psychologist, and when the newest arrived. */
  readonly pendingConcerns: { readonly count: number; readonly newestAt: Date | null };
}

export interface FeedItem {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly studentId: string | null;
  readonly at: Date;
}

/** The feed never grows past this. */
export const FEED_LIMIT = 30;

const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] ?? fullName;

/** What `actor` is told about. Parent-safe for students and parents: good news and activities only. */
export function buildFeed(actor: Pick<Actor, 'role'>, inputs: FeedInputs): FeedItem[] {
  const isStudent = actor.role === Role.Student;
  const isParent = actor.role === Role.Parent;
  const items: FeedItem[] = [];

  if (isStudent || isParent) {
    for (const star of inputs.stars) {
      const area = OBSERVATION_AREA_LABELS[star.area];
      items.push({
        id: `star:${star.id}`,
        kind: 'star',
        title: isStudent ? 'You earned a star' : `${firstName(star.student.fullName)} earned a star`,
        body: `For ${area.toLowerCase()}. Keep it up!`,
        studentId: star.student.id,
        at: star.at,
      });
    }
    for (const assignment of inputs.assignments) {
      items.push({
        id: `assigned:${assignment.id}`,
        kind: 'activity_assigned',
        title: isStudent ? 'A new activity for you' : `A new activity for ${firstName(assignment.student.fullName)}`,
        body: assignment.activityTitle,
        studentId: assignment.student.id,
        at: assignment.at,
      });
    }
  }

  if (isParent || actor.role === Role.Teacher) {
    for (const completion of inputs.completions) {
      items.push({
        id: `finished:${completion.id}`,
        kind: 'activity_finished',
        title: `${firstName(completion.student.fullName)} finished an activity`,
        body: completion.activityTitle,
        studentId: completion.student.id,
        at: completion.at,
      });
    }
  }

  if (actor.role === Role.Psychologist && inputs.pendingConcerns.count > 0 && inputs.pendingConcerns.newestAt) {
    const { count, newestAt } = inputs.pendingConcerns;
    items.push({
      id: 'review-queue',
      kind: 'review_queue',
      title: count === 1 ? '1 observation is waiting for review' : `${count} observations are waiting for review`,
      body: 'Open the review queue to look at them.',
      studentId: null,
      at: newestAt,
    });
  }

  return items.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id)).slice(0, FEED_LIMIT);
}

/** How many items arrived after `seenAt` (all of them if the feed was never opened). */
export function countUnread(items: readonly Pick<FeedItem, 'at'>[], seenAt: Date | null): number {
  return seenAt === null ? items.length : items.filter((item) => item.at.getTime() > seenAt.getTime()).length;
}
