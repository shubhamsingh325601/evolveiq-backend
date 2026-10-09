// Zod schemas for progress. Every response here is parent-safe for every audience: growth-area
// NAMES only (no tags, observations or notes), a streak count and plain template text.
import { z } from 'zod';

const Uuid = z.guid();

export const StudentIdParamsSchema = z.strictObject({ studentId: Uuid.meta({ description: 'Student user ID (UUID).' }) });

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
