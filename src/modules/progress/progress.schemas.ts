// Zod schemas for progress. Every response here is parent-safe for every audience: growth-area
// NAMES only (no tags, observations or notes), a streak count, plain template text, and stars —
// the positive observations about the student, which carry nothing clinical (a positive
// observation has no Level, review or psychologist note, and the learning-behaviour area is
// left out).
import { z } from 'zod';
import { PAGE_QUERY_FIELDS, PaginationSchema } from '../../shared/pagination/index.js';
import { describeOptions, OBSERVATION_AREA_LABELS, ObservationArea } from '../observations/observation-options.js';

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });

export const StudentIdParamsSchema = z.strictObject({ studentId: Uuid.meta({ description: 'Student user ID (UUID).' }) });

export const StarsQuerySchema = z.strictObject({ ...PAGE_QUERY_FIELDS });
export type StarsQuery = z.output<typeof StarsQuerySchema>;

export const StarSchema = z
  .object({
    id: Id.meta({ description: 'The positive observation this star was given for.' }),
    studentId: Id,
    area: z.enum(ObservationArea).meta({ description: describeOptions(OBSERVATION_AREA_LABELS) }),
    description: z.string().meta({ description: 'What was noticed, in the words of whoever gave the star.' }),
    givenBy: z.object({ fullName: z.string(), role: z.enum(['parent', 'teacher']) }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Star' });
export type StarDto = z.output<typeof StarSchema>;

export const StarListResponseSchema = z
  .object({ stars: z.array(StarSchema).meta({ description: 'Newest first.' }), pagination: PaginationSchema })
  .meta({ id: 'StarListResponse' });

export const MonthlySummaryParamsSchema = z.strictObject({
  studentId: Uuid,
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM')
    .meta({ description: 'Calendar month in Asia/Kolkata time, e.g. 2026-10.', example: '2026-10' }),
});

export const GrowthAreasResponseSchema = z
  .object({
    growthAreas: z
      .array(z.object({ name: z.string().meta({ example: 'Managing feelings' }) }))
      .max(5)
      .meta({ description: 'Up to five, most recent first.' }),
  })
  .meta({ id: 'GrowthAreasResponse' });

export const StreakResponseSchema = z
  .object({
    streak: z.object({
      days: z.number().int().min(0).meta({ description: 'Consecutive Asia/Kolkata days with at least one completed activity.' }),
    }),
  })
  .meta({ id: 'StreakResponse' });

export const MonthlySummaryResponseSchema = z
  .object({
    summary: z.object({
      studentId: z.string().meta({ format: 'uuid' }),
      month: z.string().meta({ example: '2026-10' }),
      text: z.string(),
      isFinal: z.boolean().meta({ description: 'true = a finished month, stored and never changed; false = the current month, built live.' }),
    }),
  })
  .meta({ id: 'MonthlySummaryResponse' });

// ───────────────────────────── EvolvIQ Holistic Index ─────────────────────────────

const Score = z.number().int().min(0).max(100);
const Dimension = z.enum(['education', 'skills', 'physical', 'wellbeing', 'character']);

export const HolisticIndexSchema = z
  .object({
    studentId: Id,
    score: Score.meta({ description: 'The EvolvIQ Holistic Index: the mean of the five pillars, 0–100.' }),
    dimensions: z
      .array(z.object({ dimension: Dimension, score: Score }))
      .length(5)
      .meta({ description: 'The five pillars, outermost ring first.' }),
    history: z
      .array(
        z.object({
          schoolYear: z.string().meta({ example: '2026–27' }),
          grade: z.string().nullable().meta({ description: 'The year group, when recorded. Always null today.' }),
          score: Score,
          isCurrent: z.boolean(),
        }),
      )
      .meta({ description: 'The index at the end of each school year (April–March), oldest first; the last is the year in progress.' }),
    monthly: z
      .array(z.object({ month: z.string().meta({ example: '2026-10' }), score: Score }))
      .meta({ description: 'The index at the end of each of the last six months, oldest first.' }),
    skills: z.array(z.object({ skill: z.string(), score: Score })).meta({ description: 'One per area the child has been noticed in over the last year.' }),
    strengths: z.array(z.string()),
    playbook: z.array(z.string()).meta({ description: 'Short, practical next steps. Nothing clinical.' }),
    insights: z
      .array(
        z.object({
          dimension: Dimension,
          trend: z.enum(['up', 'steady', 'down']),
          title: z.string(),
          why: z.string().meta({ description: 'Why this insight appears, in plain language.' }),
          factors: z.array(z.string()).meta({ description: 'What contributed: counts of good things noticed and activities finished.' }),
          action: z.string().meta({ description: 'A recommended next step.' }),
          confidence: z.enum(['low', 'medium', 'high']).meta({ description: 'How much evidence the insight rests on.' }),
        }),
      )
      .length(5),
    evidence: z.object({ stars: z.number().int().min(0), activitiesCompleted: z.number().int().min(0) }),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'HolisticIndex' });

export const HolisticIndexResponseSchema = z.object({ holisticIndex: HolisticIndexSchema }).meta({ id: 'HolisticIndexResponse' });

export const GrowthMomentsQuerySchema = z.strictObject({ ...PAGE_QUERY_FIELDS });
export type GrowthMomentsQuery = z.output<typeof GrowthMomentsQuerySchema>;

export const GrowthMomentSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['star', 'activity', 'milestone']),
    title: z.string(),
    detail: z.string().nullable().meta({ description: "A star's words, as the giver wrote them." }),
    area: z.enum(ObservationArea).nullable(),
    givenBy: z.object({ fullName: z.string(), role: z.enum(['parent', 'teacher']) }).nullable(),
    occurredAt: z.iso.datetime(),
  })
  .meta({ id: 'GrowthMoment' });

export const GrowthMomentListResponseSchema = z
  .object({ moments: z.array(GrowthMomentSchema).meta({ description: 'Newest first.' }), pagination: PaginationSchema })
  .meta({ id: 'GrowthMomentListResponse' });
