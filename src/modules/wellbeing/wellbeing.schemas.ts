// Zod schemas for family consent and wellbeing check-ins.
//
// Check-ins are the family's own, non-clinical notes: mood and energy on a 1-5 scale, and
// optionally sleep and active time. They are never a measurement, a score or a diagnosis.
import { z } from 'zod';
import { ConsentPurpose } from '../../generated/prisma/enums.js';

export { ConsentPurpose };

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
const Day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD');

export const CONSENT_PURPOSE_LABELS: Readonly<Record<ConsentPurpose, string>> = Object.freeze({
  wellness_tracking: 'Record daily wellbeing check-ins',
  wellness_sharing: "Share those check-ins with my child's teachers and counsellor",
});

export const StudentIdParamsSchema = z.strictObject({ studentId: Uuid.meta({ description: 'Student user ID (UUID).' }) });
export const ConsentParamsSchema = z.strictObject({ studentId: Uuid, purpose: z.enum(ConsentPurpose) });

export const ConsentBodySchema = z.strictObject({ granted: z.boolean() });
export type ConsentBody = z.output<typeof ConsentBodySchema>;

export const ConsentSchema = z
  .object({
    purpose: z.enum(ConsentPurpose),
    label: z.string(),
    granted: z.boolean().meta({ description: 'false when refused, withdrawn or not decided yet.' }),
    decidedAt: z.iso.datetime().nullable().meta({ description: 'null until a parent decides.' }),
  })
  .meta({ id: 'Consent' });
export type ConsentDto = z.output<typeof ConsentSchema>;

export const ConsentListResponseSchema = z.object({ consents: z.array(ConsentSchema) }).meta({ id: 'ConsentListResponse' });
export const ConsentResponseSchema = z.object({ consent: ConsentSchema }).meta({ id: 'ConsentResponse' });

export const CheckinBodySchema = z
  .strictObject({
    day: Day.optional().meta({ description: 'The Asia/Kolkata day, default today. Not in the future, not older than 30 days.' }),
    mood: z.number().int().min(1).max(5).meta({ description: '1 (low) to 5 (great).' }),
    energy: z.number().int().min(1).max(5).meta({ description: '1 (tired) to 5 (full of energy).' }),
    sleepMinutes: z.number().int().min(0).max(1080).optional(),
    activeMinutes: z.number().int().min(0).max(720).optional(),
  })
  .meta({ id: 'WellnessCheckinBody' });
export type CheckinBody = z.output<typeof CheckinBodySchema>;

export const CheckinsQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(7).max(90).default(30).meta({ description: 'How many recent days to return.' }),
});
export type CheckinsQuery = z.output<typeof CheckinsQuerySchema>;

export const CheckinSchema = z
  .object({
    day: Day,
    mood: z.number().int(),
    energy: z.number().int(),
    sleepMinutes: z.number().int().nullable(),
    activeMinutes: z.number().int().nullable(),
  })
  .meta({ id: 'WellnessCheckin' });
export type CheckinDto = z.output<typeof CheckinSchema>;

export const CheckinSummarySchema = z
  .object({
    days: z.number().int().meta({ description: 'Check-ins in the period.' }),
    averageMood: z.number().nullable(),
    averageEnergy: z.number().nullable(),
    averageSleepMinutes: z.number().int().nullable(),
    averageActiveMinutes: z.number().int().nullable(),
  })
  .meta({ id: 'WellnessSummary' });
export type CheckinSummaryDto = z.output<typeof CheckinSummarySchema>;

export const CheckinsResponseSchema = z
  .object({
    isTracking: z.boolean().meta({ description: 'The family allows check-ins to be recorded.' }),
    isSharedWithSchool: z.boolean().meta({ description: 'The family allows teachers and the counsellor to see them.' }),
    isVisible: z
      .boolean()
      .meta({ description: 'false when a teacher or counsellor asks and the family has not shared: the list is then empty.' }),
    checkins: z.array(CheckinSchema).meta({ description: 'Oldest first.' }),
    summary: CheckinSummarySchema,
  })
  .meta({ id: 'WellnessCheckinsResponse' });
export type CheckinsResponse = z.output<typeof CheckinsResponseSchema>;

export const CheckinResponseSchema = z.object({ checkin: CheckinSchema }).meta({ id: 'WellnessCheckinResponse' });

export { Id };
