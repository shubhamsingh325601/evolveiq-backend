// Zod schemas for observations — validated at the route boundary.
//
// There is one response shape PER AUDIENCE, each an explicit allow-list, and each route
// declares exactly one of them (the serializer drops anything not declared):
//   ParentObservation    what a parent wrote + its status. Nothing clinical.
//   TeacherObservation   what a teacher wrote + status + the psychologist's teacher-only note.
//   ReviewObservation    the psychologist's full view (queue, detail, history).
//
// Every observation has a tone: a concern (reviewed by a psychologist, as before) or a positive
// one (a star for the student, celebrated straight away and never reviewed).
import { z } from 'zod';
import { PAGE_QUERY_FIELDS, PaginationSchema, SORT_ORDERS } from '../../shared/pagination/index.js';
import {
  DEVELOPMENT_AREA_LABELS,
  DevelopmentArea,
  describeOptions,
  LEARNING_BEHAVIOUR_AREA_LABELS,
  LearningBehaviourArea,
  OBSERVATION_AREA_LABELS,
  OBSERVATION_FREQUENCY_LABELS,
  OBSERVATION_LEVEL_LABELS,
  OBSERVATION_STATUS_LABELS,
  OBSERVATION_TONE_LABELS,
  OBSERVATION_WHEN_LABELS,
  ObservationArea,
  ObservationFrequency,
  ObservationLevel,
  ObservationStatus,
  ObservationTone,
  ObservationWhen,
} from './observation-options.js';

const Uuid = z.guid();
// Non-blank free text, no control characters except newlines and tabs.
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;
const freeText = (max: number) => z.string().max(max).regex(FREE_TEXT, 'must not be blank or contain control characters');

const AreaSchema = z.enum(ObservationArea).meta({ description: describeOptions(OBSERVATION_AREA_LABELS) });
const WhenSchema = z.enum(ObservationWhen).meta({ description: describeOptions(OBSERVATION_WHEN_LABELS) });
const HowOftenSchema = z.enum(ObservationFrequency).meta({ description: describeOptions(OBSERVATION_FREQUENCY_LABELS) });
const LevelSchema = z
  .enum(ObservationLevel)
  .meta({ description: `Teachers only, and only on a concern. ${describeOptions(OBSERVATION_LEVEL_LABELS)}` });
const ToneSchema = z.enum(ObservationTone).meta({
  description:
    `${describeOptions(OBSERVATION_TONE_LABELS)}. A positive observation is a star for the student: ` +
    'celebrated at once, never reviewed.',
});
const LearningBehaviourAreaSchema = z
  .enum(LearningBehaviourArea)
  .meta({ description: `Teachers only. ${describeOptions(LEARNING_BEHAVIOUR_AREA_LABELS)}` });
const DevelopmentAreaSchema = z.enum(DevelopmentArea).meta({ description: describeOptions(DEVELOPMENT_AREA_LABELS) });
const StatusSchema = z.enum(ObservationStatus).meta({ description: describeOptions(OBSERVATION_STATUS_LABELS) });

// ---------- Create ----------
const COMMON_FIELDS = {
  studentId: Uuid.meta({ description: 'The student the observation is about.' }),
  tone: ToneSchema.default('concern'),
  area: AreaSchema,
  description: freeText(2000).meta({ description: 'What was observed (free text, ≤ 2000 characters).' }),
  when: WhenSchema,
  howOften: HowOftenSchema,
};

/** Parents: Level and learning-behaviour area are teacher-only, so sending them → 400. */
export const ParentObservationBodySchema = z.strictObject(COMMON_FIELDS).meta({ id: 'ParentObservationRequest' });
export type ParentObservationBody = z.output<typeof ParentObservationBodySchema>;

export const TeacherObservationBodySchema = z
  .strictObject({ ...COMMON_FIELDS, level: LevelSchema.optional(), learningBehaviourArea: LearningBehaviourAreaSchema.optional() })
  .meta({ id: 'TeacherObservationRequest' });
export type TeacherObservationBody = z.output<typeof TeacherObservationBodySchema>;

// ---------- Review ----------
const REVIEW_FIELDS = {
  developmentArea: DevelopmentAreaSchema.optional().meta({ description: 'Required when the observation is Significant.' }),
  teacherOnlyNote: freeText(2000).optional().meta({ description: 'Shown to the authoring teacher and psychologists; never to parents.' }),
};

export const ReviewBodySchema = z
  .discriminatedUnion(
    'outcome',
    [
      z.strictObject({
        outcome: z.literal('assigned').meta({ description: '"Assign & mark reviewed".' }),
        activityIds: z
          .array(Uuid)
          .min(1)
          .max(10)
          .refine((ids) => new Set(ids).size === ids.length, 'must not contain duplicates')
          .meta({ description: 'Activities to assign to the student (recommended), 1–10, not archived.' }),
        ...REVIEW_FIELDS,
      }),
      z.strictObject({ outcome: z.literal('no_action').meta({ description: '"No action needed".' }), ...REVIEW_FIELDS }),
    ],
    { error: 'must be "assigned" or "no_action"' },
  )
  .meta({ id: 'ReviewObservationRequest' });
export type ReviewBody = z.output<typeof ReviewBodySchema>;

// ---------- Params / queries ----------
export const ObservationIdParamsSchema = z.strictObject({ observationId: Uuid.meta({ description: 'Observation ID (UUID).' }) });

export const ListOwnObservationsQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  status: StatusSchema.optional(),
});
export type ListOwnObservationsQuery = z.output<typeof ListOwnObservationsQuerySchema>;

/** The psychologist's queue: Pending, Significant, From parents, Reviewed, by school. */
export const ReviewQueueQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  sortOrder: z.enum(SORT_ORDERS).default('desc').meta({ description: 'By creation time (default "desc", newest first).' }),
  status: StatusSchema.optional().meta({ description: '"pending" = Pending, "reviewed" = Reviewed.' }),
  tone: ToneSchema.optional().meta({ description: '"concern" = only what is for review; "positive" = only stars.' }),
  level: LevelSchema.optional().meta({ description: '"significant" = the Significant filter.' }),
  authorRole: z.enum(['parent', 'teacher']).optional().meta({ description: '"parent" = From parents.' }),
  schoolId: Uuid.optional().meta({ description: 'By school.' }),
  studentId: Uuid.optional(),
  area: AreaSchema.optional(),
});
export type ReviewQueueQuery = z.output<typeof ReviewQueueQuerySchema>;

// ---------- Responses ----------
const Iso = z.iso.datetime();
const Id = z.string().meta({ format: 'uuid' });

export const ParentObservationSchema = z
  .object({
    id: Id,
    studentId: Id,
    tone: ToneSchema,
    area: AreaSchema,
    description: z.string(),
    when: WhenSchema,
    howOften: HowOftenSchema,
    status: StatusSchema,
    createdAt: Iso,
  })
  .meta({ id: 'ParentObservation' });
export type ParentObservationDto = z.output<typeof ParentObservationSchema>;

export const TeacherObservationSchema = z
  .object({
    id: Id,
    studentId: Id,
    tone: ToneSchema,
    area: AreaSchema,
    description: z.string(),
    when: WhenSchema,
    howOften: HowOftenSchema,
    level: LevelSchema.nullable(),
    learningBehaviourArea: LearningBehaviourAreaSchema.nullable(),
    status: StatusSchema,
    teacherOnlyNote: z.string().nullable().meta({ description: "The psychologist's note for the teacher, once reviewed." }),
    reviewedAt: Iso.nullable().meta({ description: 'When it was reviewed; null while pending.' }),
    createdAt: Iso,
  })
  .meta({ id: 'TeacherObservation' });
export type TeacherObservationDto = z.output<typeof TeacherObservationSchema>;

const PersonSchema = z.object({ id: Id, fullName: z.string() });

export const ReviewObservationSchema = z
  .object({
    id: Id,
    schoolId: Id,
    student: PersonSchema,
    author: PersonSchema.extend({ role: z.enum(['parent', 'teacher']) }),
    tone: ToneSchema,
    area: AreaSchema,
    description: z.string(),
    when: WhenSchema,
    howOften: HowOftenSchema,
    level: LevelSchema.nullable(),
    learningBehaviourArea: LearningBehaviourAreaSchema.nullable(),
    status: StatusSchema,
    review: z
      .object({
        outcome: z.enum(['assigned', 'no_action']),
        developmentArea: DevelopmentAreaSchema.nullable(),
        teacherOnlyNote: z.string().nullable(),
        reviewedBy: PersonSchema,
        reviewedAt: Iso,
        activityIds: z.array(Id).meta({ description: 'Activities assigned by this review.' }),
      })
      .nullable(),
    createdAt: Iso,
  })
  .meta({ id: 'ReviewObservation' });
export type ReviewObservationDto = z.output<typeof ReviewObservationSchema>;

export const ParentObservationResponseSchema = z.object({ observation: ParentObservationSchema }).meta({ id: 'ParentObservationResponse' });
export const ParentObservationListResponseSchema = z
  .object({ observations: z.array(ParentObservationSchema), pagination: PaginationSchema })
  .meta({ id: 'ParentObservationListResponse' });

export const TeacherObservationResponseSchema = z.object({ observation: TeacherObservationSchema }).meta({ id: 'TeacherObservationResponse' });
export const TeacherObservationListResponseSchema = z
  .object({ observations: z.array(TeacherObservationSchema), pagination: PaginationSchema })
  .meta({ id: 'TeacherObservationListResponse' });

export const ReviewQueueResponseSchema = z
  .object({ observations: z.array(ReviewObservationSchema), pagination: PaginationSchema })
  .meta({ id: 'ReviewQueueResponse' });
export const ObservationDetailResponseSchema = z
  .object({
    observation: ReviewObservationSchema,
    history: z.array(ReviewObservationSchema).meta({ description: "The student's other observations, newest first (up to 20)." }),
  })
  .meta({ id: 'ObservationDetailResponse' });
export const ReviewResponseSchema = z.object({ observation: ReviewObservationSchema }).meta({ id: 'ReviewObservationResponse' });
