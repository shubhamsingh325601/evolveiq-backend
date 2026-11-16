// Zod schemas for the Staff Training & Development Hub — a gap found against the client's
// prototype, not yet confirmed scope (SCOPE_OF_WORK.md, 16 Nov 2026). A School Admin offers a
// training for their school; a Platform Admin for one school or for every school, exactly like
// the notice board. Deliberately a dumb CRUD list of two things (trainings, and who's enrolled):
// no completion rate or "X% of staff" number here — that's the frontend's job from these same
// list endpoints.
import { z } from 'zod';
import { TrainingRequirement } from '../../generated/prisma/enums.js';
import { PAGE_QUERY_FIELDS, PaginationSchema } from '../../shared/pagination/index.js';

export { TrainingRequirement };

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
const Day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD');
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;
const freeText = (max: number) => z.string().max(max).regex(FREE_TEXT, 'must not be blank or contain control characters');

export const TrainingIdParamsSchema = z.strictObject({ trainingId: Uuid });

export const ListTrainingsQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  requirement: z.enum(TrainingRequirement).optional(),
  schoolId: Uuid.optional().meta({ description: 'Platform Admins only: one school’s trainings.' }),
});
export type ListTrainingsQuery = z.output<typeof ListTrainingsQuerySchema>;

const fields = {
  title: freeText(120),
  description: freeText(2000).meta({ description: 'What it covers, in plain words.' }),
  scheduledOn: Day.meta({ description: 'When it happens. Leave out for self-paced or ongoing training.' }),
  requirement: z.enum(TrainingRequirement),
  credits: z.number().int().min(0).max(20).meta({ description: 'Training credits earned on completion, 0–20.' }),
};

export const CreateTrainingBodySchema = z
  .strictObject({
    title: fields.title,
    description: fields.description.optional(),
    scheduledOn: fields.scheduledOn.optional(),
    requirement: fields.requirement,
    credits: fields.credits,
    schoolId: Uuid.optional().meta({
      description: 'Platform Admins: the school, or leave it out for every school. School Admins: always their own.',
    }),
  })
  .meta({ id: 'CreateTrainingBody' });
export type CreateTrainingBody = z.output<typeof CreateTrainingBodySchema>;

export const UpdateTrainingBodySchema = z
  .strictObject({
    title: fields.title.optional(),
    description: fields.description.nullable().optional(),
    scheduledOn: fields.scheduledOn.nullable().optional(),
    requirement: fields.requirement.optional(),
    credits: fields.credits.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'send at least one field to change')
  .meta({ id: 'UpdateTrainingBody', description: 'null clears an optional field.' });
export type UpdateTrainingBody = z.output<typeof UpdateTrainingBodySchema>;

export const EnrolmentSchema = z
  .object({ isComplete: z.boolean() })
  .meta({ id: 'TrainingEnrolment', description: 'The caller’s own enrolment. Never another staff member’s.' });
export type EnrolmentDto = z.output<typeof EnrolmentSchema>;
export const EnrolmentResponseSchema = z.object({ enrolment: EnrolmentSchema }).meta({ id: 'TrainingEnrolmentResponse' });

export const TrainingSchema = z
  .object({
    id: Id,
    schoolId: Id.nullable().meta({ description: 'Null: offered to every school.' }),
    schoolName: z.string().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    scheduledOn: Day.nullable(),
    requirement: z.enum(TrainingRequirement),
    credits: z.number().int(),
    createdBy: z.object({ fullName: z.string() }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    canManage: z.boolean().meta({ description: 'Whether the caller may edit or delete it.' }),
    myEnrolment: EnrolmentSchema.nullable().meta({ description: 'The caller’s own enrolment, if any.' }),
  })
  .meta({ id: 'Training' });
export type TrainingDto = z.output<typeof TrainingSchema>;

export const TrainingResponseSchema = z.object({ training: TrainingSchema }).meta({ id: 'TrainingResponse' });
export const TrainingListResponseSchema = z
  .object({ trainings: z.array(TrainingSchema).meta({ description: 'Newest first.' }), pagination: PaginationSchema })
  .meta({ id: 'TrainingListResponse' });
