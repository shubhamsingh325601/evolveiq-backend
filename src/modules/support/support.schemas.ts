// Zod schemas for school support plans (the special-needs workflow). Staff only: nothing here
// is ever returned to a parent or a student.
import { z } from 'zod';
import { SupportCategory, SupportStatus } from '../../generated/prisma/enums.js';

export { SupportCategory, SupportStatus };

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
const Day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD');
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;
const freeText = (max: number) => z.string().max(max).regex(FREE_TEXT, 'must not be blank or contain control characters');

export const SUPPORT_CATEGORY_LABELS: Readonly<Record<SupportCategory, string>> = Object.freeze({
  learning: 'Learning support',
  attention: 'Attention and focus',
  speech_language: 'Speech and language',
  sensory: 'Sensory needs',
  physical_access: 'Physical access',
  emotional: 'Emotional support',
  gifted: 'Stretch and enrichment',
  other: 'Other',
});

export const SUPPORT_STATUS_LABELS: Readonly<Record<SupportStatus, string>> = Object.freeze({
  active: 'In place',
  in_review: 'Being reviewed',
  closed: 'Closed',
});

export const StudentIdParamsSchema = z.strictObject({ studentId: Uuid.meta({ description: 'Student user ID (UUID).' }) });
export const PlanIdParamsSchema = z.strictObject({ planId: Uuid });

export const CreatePlanBodySchema = z
  .strictObject({
    category: z.enum(SupportCategory),
    summary: freeText(1000).meta({ description: 'What the student needs, in plain words.' }),
    strategies: freeText(2000).optional().meta({ description: 'What works in class.' }),
    reviewOn: Day.optional().meta({ description: 'When to look at the plan again.' }),
  })
  .meta({ id: 'CreateSupportPlanBody' });
export type CreatePlanBody = z.output<typeof CreatePlanBodySchema>;

export const UpdatePlanBodySchema = z
  .strictObject({
    summary: freeText(1000).optional(),
    strategies: freeText(2000).nullable().optional().meta({ description: 'null clears them.' }),
    status: z.enum(SupportStatus).optional(),
    reviewOn: Day.nullable().optional().meta({ description: 'null clears the date.' }),
  })
  .refine((body) => Object.keys(body).length > 0, 'send at least one field to change')
  .meta({ id: 'UpdateSupportPlanBody' });
export type UpdatePlanBody = z.output<typeof UpdatePlanBodySchema>;

export const SupportPlanSchema = z
  .object({
    id: Id,
    studentId: Id,
    category: z.enum(SupportCategory),
    categoryLabel: z.string(),
    summary: z.string(),
    strategies: z.string().nullable(),
    status: z.enum(SupportStatus),
    statusLabel: z.string(),
    reviewOn: Day.nullable(),
    isReviewDue: z.boolean().meta({ description: 'The review date has arrived and the plan is not closed.' }),
    createdBy: z.object({ fullName: z.string() }),
    createdAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'SupportPlan' });
export type SupportPlanDto = z.output<typeof SupportPlanSchema>;

export const SupportPlanListResponseSchema = z
  .object({ plans: z.array(SupportPlanSchema).meta({ description: 'Open plans first, newest first.' }) })
  .meta({ id: 'SupportPlanListResponse' });
export const SupportPlanResponseSchema = z.object({ plan: SupportPlanSchema }).meta({ id: 'SupportPlanResponse' });
