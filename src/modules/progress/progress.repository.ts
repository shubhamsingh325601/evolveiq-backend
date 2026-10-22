// Database access for progress (growth areas, streaks, stars, monthly summaries). No business
// rules. Business days are computed by PostgreSQL with the one business time zone passed in
// (business-time.ts) — `ts AT TIME ZONE zone` for instants → local days, and
// `'YYYY-MM-DD'::timestamp AT TIME ZONE zone` for local midnights → instants.
import type { Prisma } from '../../generated/prisma/client.js';
import type { DevelopmentArea } from '../../generated/prisma/enums.js';
import type { Db } from '../../shared/db/prisma.js';
import { BUSINESS_TIME_ZONE } from './business-time.js';

const TZ = BUSINESS_TIME_ZONE;
const GROWTH_AREA_LIMIT = 5;

// A star is a positive observation. Only what the star shows is selected — never the
// learning-behaviour area, and a positive observation has no Level or review to select.
const STAR_SELECT = {
  id: true,
  studentId: true,
  area: true,
  description: true,
  authorRole: true,
  createdAt: true,
  author: { select: { fullName: true } },
} as const satisfies Prisma.ObservationSelect;

export type StarRecord = Prisma.ObservationGetPayload<{ select: typeof STAR_SELECT }>;

export function createProgressRepository(db: Db) {
  return {
    /** The student's stars (positive observations), newest first. */
    async stars(studentId: string, page: { skip: number; take: number }): Promise<{ items: StarRecord[]; total: number }> {
      const where = { studentId, tone: 'positive' } as const satisfies Prisma.ObservationWhereInput;
      const [items, total] = await db.$transaction([
        db.observation.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
          select: STAR_SELECT,
        }),
        db.observation.count({ where }),
      ]);
      return { items, total };
    },

    /** Stars given in the business month [first, nextFirst), up to `asOf`. */
    async monthStars(studentId: string, month: { first: string; nextFirst: string }, asOf: Date): Promise<number> {
      const [row] = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM observations
        WHERE student_id = ${studentId}::uuid AND tone = 'positive'
          AND created_at >= (${month.first}::timestamp AT TIME ZONE ${TZ})
          AND created_at <  (${month.nextFirst}::timestamp AT TIME ZONE ${TZ})
          AND created_at <= ${asOf}::timestamptz`;
      return row?.n ?? 0;
    },

    /** Distinct business days ("YYYY-MM-DD") with at least one completion, up to `asOf`. */
    async completionDays(studentId: string, asOf: Date): Promise<string[]> {
      const rows = await db.$queryRaw<{ day: string }[]>`
        SELECT DISTINCT to_char(c.completed_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day
        FROM activity_completions c JOIN assignments a ON a.id = c.assignment_id
        WHERE a.student_id = ${studentId}::uuid AND c.completed_at <= ${asOf}::timestamptz`;
      return rows.map((r) => r.day);
    },

    /** Completions in the business month [first, nextFirst), up to `asOf`: count + distinct days. */
    async monthActivity(studentId: string, month: { first: string; nextFirst: string }, asOf: Date): Promise<{ completed: number; days: string[] }> {
      const rows = await db.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(c.completed_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day, count(*)::int AS n
        FROM activity_completions c JOIN assignments a ON a.id = c.assignment_id
        WHERE a.student_id = ${studentId}::uuid
          AND c.completed_at >= (${month.first}::timestamp AT TIME ZONE ${TZ})
          AND c.completed_at <  (${month.nextFirst}::timestamp AT TIME ZONE ${TZ})
          AND c.completed_at <= ${asOf}::timestamptz
        GROUP BY 1`;
      return { completed: rows.reduce((sum, r) => sum + r.n, 0), days: rows.map((r) => r.day) };
    },

    /**
     * The most recent distinct development areas from the student's "Assign & mark reviewed"
     * reviews, newest first — at most five. `beforeDay` (optional) also caps it at the start of
     * that business day (for a past month's summary).
     */
    async growthAreas(studentId: string, asOf: Date, beforeDay?: string): Promise<DevelopmentArea[]> {
      const rows = await db.$queryRaw<{ development_area: DevelopmentArea }[]>`
        SELECT development_area
        FROM observations
        WHERE student_id = ${studentId}::uuid
          AND review_outcome = 'assigned' AND development_area IS NOT NULL
          AND reviewed_at <= ${asOf}::timestamptz
          AND (${beforeDay ?? null}::date IS NULL OR reviewed_at < (${beforeDay ?? null}::date::timestamp AT TIME ZONE ${TZ}))
        GROUP BY development_area
        ORDER BY max(reviewed_at) DESC, development_area
        LIMIT ${GROWTH_AREA_LIMIT}`;
      return rows.map((r) => r.development_area);
    },

    async findSummary(studentId: string, first: string): Promise<string | null> {
      const row = await db.monthlySummary.findUnique({
        where: { studentId_month: { studentId, month: new Date(`${first}T00:00:00.000Z`) } },
        select: { summary: true },
      });
      return row?.summary ?? null;
    },

    /** Stores the summary unless one already exists (the first one written wins, forever). */
    async insertSummary(studentId: string, first: string, summary: string): Promise<void> {
      await db.monthlySummary.createMany({
        data: [{ studentId, month: new Date(`${first}T00:00:00.000Z`), summary }],
        skipDuplicates: true,
      });
    },
  };
}

export type ProgressRepository = ReturnType<typeof createProgressRepository>;
