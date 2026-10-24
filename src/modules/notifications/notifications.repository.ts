// Database access for the notification feed. No business rules.
import type { Db } from '../../shared/db/prisma.js';
import type { Actor } from '../../shared/rbac/index.js';
import { studentScope } from '../users/student-scope.js';
import type { FeedAssignment, FeedCompletion, FeedInputs, FeedStar } from './notifications.js';

/** Per source; the feed keeps the newest few dozen overall. */
const PER_SOURCE = 25;
const STUDENT = { select: { id: true, fullName: true } } as const;

export function createNotificationsRepository(db: Db) {
  return {
    /** The raw events `actor` can be told about, newest first within each source. */
    async inputs(actor: Actor): Promise<FeedInputs> {
      const students = studentScope(actor);
      const [stars, assignments, completions, pending] = await Promise.all([
        db.observation.findMany({
          where: { tone: 'positive', student: students },
          orderBy: { createdAt: 'desc' },
          take: PER_SOURCE,
          select: { id: true, createdAt: true, area: true, student: STUDENT },
        }),
        db.assignment.findMany({
          where: { student: students },
          orderBy: { createdAt: 'desc' },
          take: PER_SOURCE,
          select: { id: true, createdAt: true, activity: { select: { title: true } }, student: STUDENT },
        }),
        db.activityCompletion.findMany({
          where: { assignment: { student: students } },
          orderBy: { completedAt: 'desc' },
          take: PER_SOURCE,
          select: { id: true, completedAt: true, assignment: { select: { activity: { select: { title: true } }, student: STUDENT } } },
        }),
        db.observation.aggregate({ where: { status: 'pending' }, _count: true, _max: { createdAt: true } }),
      ]);

      return {
        stars: stars.map((s): FeedStar => ({ id: s.id, at: s.createdAt, area: s.area, student: s.student })),
        assignments: assignments.map((a): FeedAssignment => ({ id: a.id, at: a.createdAt, activityTitle: a.activity.title, student: a.student })),
        completions: completions.map(
          (c): FeedCompletion => ({
            id: c.id,
            at: c.completedAt,
            activityTitle: c.assignment.activity.title,
            student: c.assignment.student,
          }),
        ),
        pendingConcerns: { count: pending._count, newestAt: pending._max.createdAt },
      };
    },

    async seenAt(userId: string): Promise<Date | null> {
      const state = await db.notificationState.findUnique({ where: { userId }, select: { seenAt: true } });
      return state?.seenAt ?? null;
    },

    async markSeen(userId: string, at: Date): Promise<void> {
      await db.notificationState.upsert({ where: { userId }, create: { userId, seenAt: at }, update: { seenAt: at } });
    },
  };
}

export type NotificationsRepository = ReturnType<typeof createNotificationsRepository>;
