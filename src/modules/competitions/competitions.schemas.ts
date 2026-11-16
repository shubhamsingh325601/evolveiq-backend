// Zod schemas for Events & Competitions (gap found against the client's prototype, not yet
// confirmed scope — SCOPE_OF_WORK.md, 16 Nov 2026). A school enters students into a
// National/State/Inter-School/Intra-School competition; a teacher nominates which students go.
import { z } from 'zod';
import { CompetitionLevel, CompetitionStatus } from '../../generated/prisma/enums.js';
import { PAGE_QUERY_FIELDS, PaginationSchema } from '../../shared/pagination/index.js';

export { CompetitionLevel, CompetitionStatus };

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
const Day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD');
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;
const freeText = (max: number) => z.string().max(max).regex(FREE_TEXT, 'must not be blank or contain control characters');

export const CompetitionIdParamsSchema = z.strictObject({ competitionId: Uuid });

export const NominationParamsSchema = z.strictObject({
  competitionId: Uuid,
  studentId: Uuid,
});

export const ListCompetitionsQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  schoolId: Uuid.optional().meta({ description: 'Platform Admins only: one school’s competitions.' }),
});
export type ListCompetitionsQuery = z.output<typeof ListCompetitionsQuerySchema>;

const fields = {
  title: freeText(120),
  level: z.enum(CompetitionLevel).meta({ description: 'national, state, inter_school or intra_school.' }),
  status: z.enum(CompetitionStatus),
  scheduledOn: Day.meta({ description: 'When the competition happens.' }),
};

export const CreateCompetitionBodySchema = z
  .strictObject({
    title: fields.title,
    level: fields.level,
    scheduledOn: fields.scheduledOn.optional(),
    schoolId: Uuid.optional().meta({
      description:
        'Platform Admins: the school this competition is for — required, no "every school" option. School Admins: always their own.',
    }),
  })
  .meta({ id: 'CreateCompetitionBody' });
export type CreateCompetitionBody = z.output<typeof CreateCompetitionBodySchema>;

export const UpdateCompetitionBodySchema = z
  .strictObject({
    title: fields.title.optional(),
    level: fields.level.optional(),
    status: fields.status.optional(),
    scheduledOn: fields.scheduledOn.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'send at least one field to change')
  .meta({ id: 'UpdateCompetitionBody', description: 'null clears scheduledOn.' });
export type UpdateCompetitionBody = z.output<typeof UpdateCompetitionBodySchema>;

export const NominateBodySchema = z
  .strictObject({ studentId: Uuid.meta({ description: 'A student of the teacher’s own school/classes.' }) })
  .meta({ id: 'NominateBody' });
export type NominateBody = z.output<typeof NominateBodySchema>;

export const NominationSchema = z
  .object({
    studentId: Id,
    studentName: z.string(),
    nominatedBy: z.object({ fullName: z.string() }),
  })
  .meta({ id: 'CompetitionNomination' });
export type NominationDto = z.output<typeof NominationSchema>;
export const NominationResponseSchema = z.object({ nomination: NominationSchema }).meta({ id: 'CompetitionNominationResponse' });

export const CompetitionSchema = z
  .object({
    id: Id,
    schoolId: Id,
    title: z.string(),
    level: z.enum(CompetitionLevel),
    status: z.enum(CompetitionStatus),
    scheduledOn: Day.nullable(),
    nominations: z.array(NominationSchema).meta({ description: 'This competition’s own nominated students, oldest first.' }),
    createdBy: z.object({ fullName: z.string() }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Competition' });
export type CompetitionDto = z.output<typeof CompetitionSchema>;

export const CompetitionResponseSchema = z.object({ competition: CompetitionSchema }).meta({ id: 'CompetitionResponse' });
export const CompetitionListResponseSchema = z
  .object({ competitions: z.array(CompetitionSchema), pagination: PaginationSchema })
  .meta({ id: 'CompetitionListResponse' });
