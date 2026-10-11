// Zod schemas for the activity library, assignments and completions.
//
// The five activity types are ONE discriminated union on `type` (ActivityContentSchema), and
// a student's answer is ONE discriminated union on the same `type` (ActivityAnswerSchema).
// Every create / edit / submit goes through these two schemas.
import { z } from 'zod';
import { ActivityType } from '../../generated/prisma/enums.js';
import { PAGE_QUERY_FIELDS, PaginationSchema, SORT_ORDERS } from '../../shared/pagination/index.js';

export { ActivityType };

export const ACTIVITY_TYPE_LABELS: Readonly<Record<ActivityType, string>> = Object.freeze({
  mcq: 'Multiple choice',
  text: 'Text',
  image_pick: 'Image pick',
  rating: '1–5 rating',
  media_response: 'Media + response',
});

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
const Iso = z.iso.datetime();
// Non-blank, no control characters except newlines and tabs.
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;
const freeText = (max: number) => z.string().max(max).regex(FREE_TEXT, 'must not be blank or contain control characters');
/** http(s) only — media and images are links; there is no file upload in the MVP. */
const HttpUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).max(2048);
const OptionId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, 'must be 1–32 letters, digits, "_" or "-"')
  .meta({ description: 'Chosen by the author; unique within the activity. Students answer with it.' });

const options = <T extends z.ZodType<{ id: string }>>(option: T) =>
  z
    .array(option)
    .min(2)
    .max(6)
    .refine((list) => new Set(list.map((o) => o.id)).size === list.length, 'option ids must be unique');

const Prompt = freeText(1000).meta({ description: 'The question or instruction shown to the student.' });

export const ActivityContentSchema = z
  .discriminatedUnion(
    'type',
    [
      z.strictObject({
        type: z.literal('mcq'),
        prompt: Prompt,
        options: options(z.strictObject({ id: OptionId, label: freeText(200) })),
      }),
      z.strictObject({ type: z.literal('text'), prompt: Prompt }),
      z.strictObject({
        type: z.literal('image_pick'),
        prompt: Prompt,
        options: options(z.strictObject({ id: OptionId, imageUrl: HttpUrl, label: freeText(200).optional() })),
      }),
      z.strictObject({ type: z.literal('rating'), prompt: Prompt }),
      z.strictObject({ type: z.literal('media_response'), prompt: Prompt, mediaUrl: HttpUrl }),
    ],
    { error: 'must be one of: mcq, text, image_pick, rating, media_response' },
  )
  .meta({
    id: 'ActivityContent',
    description:
      'mcq: single-select options (no correct answer, no scoring). text: free-text answer. ' +
      'image_pick: pick one image (URLs). rating: a whole number 1–5. media_response: a media ' +
      'URL plus a text answer.',
  });
export type ActivityContent = z.output<typeof ActivityContentSchema>;

export const ActivityAnswerSchema = z
  .discriminatedUnion(
    'type',
    [
      z.strictObject({ type: z.literal('mcq'), optionId: OptionId }),
      z.strictObject({ type: z.literal('text'), text: freeText(2000) }),
      z.strictObject({ type: z.literal('image_pick'), optionId: OptionId }),
      z.strictObject({ type: z.literal('rating'), rating: z.number().int().min(1).max(5) }),
      z.strictObject({ type: z.literal('media_response'), text: freeText(2000) }),
    ],
    { error: 'must be one of: mcq, text, image_pick, rating, media_response' },
  )
  .meta({ id: 'ActivityAnswer', description: "The student's answer; `type` must match the activity's type." });
export type ActivityAnswer = z.output<typeof ActivityAnswerSchema>;

// ---------- Library requests ----------
const Title = freeText(200).meta({ example: 'How are you feeling today?' });

export const CreateActivityBodySchema = z
  .strictObject({ title: Title, content: ActivityContentSchema })
  .meta({ id: 'CreateActivityRequest' });
export type CreateActivityBody = z.output<typeof CreateActivityBodySchema>;

export const UpdateActivityBodySchema = z
  .strictObject({ title: Title.optional(), content: ActivityContentSchema.optional() })
  .refine((body) => body.title !== undefined || body.content !== undefined, { message: 'Provide title and/or content.' })
  .meta({
    id: 'UpdateActivityRequest',
    description: '`content` replaces the whole content. Once assigned, its type and options are frozen.',
  });
export type UpdateActivityBody = z.output<typeof UpdateActivityBodySchema>;

export const ActivityIdParamsSchema = z.strictObject({ activityId: Uuid.meta({ description: 'Activity ID (UUID).' }) });

export const ACTIVITY_SORT_FIELDS = ['title', 'createdAt'] as const;
export type ActivitySortField = (typeof ACTIVITY_SORT_FIELDS)[number];

export const ListActivitiesQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  sortBy: z.enum(ACTIVITY_SORT_FIELDS).default('title'),
  sortOrder: z.enum(SORT_ORDERS).default('asc'),
  type: z.enum(ActivityType).optional(),
  title: z
    .string()
    .max(200)
    .transform((value) => value.trim() || undefined)
    .optional()
    .meta({ description: 'Case-insensitive "contains" filter on the title.' }),
  isArchived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .meta({ description: 'Psychologists only: "true" lists archived activities. Default: active ones.' }),
});
export type ListActivitiesQuery = z.output<typeof ListActivitiesQuerySchema>;

// ---------- Library responses ----------
export const ActivitySchema = z
  .object({
    id: Id,
    title: z.string(),
    content: ActivityContentSchema,
    isArchived: z.boolean(),
    isAssigned: z.boolean().meta({ description: 'Assigned at least once: type and options are frozen.' }),
    createdAt: Iso,
    updatedAt: Iso,
  })
  .meta({ id: 'Activity' });
export type ActivityDto = z.output<typeof ActivitySchema>;

export const ActivityResponseSchema = z.object({ activity: ActivitySchema }).meta({ id: 'ActivityResponse' });
export const ActivityListResponseSchema = z
  .object({ activities: z.array(ActivitySchema), pagination: PaginationSchema })
  .meta({ id: 'ActivityListResponse' });

// ---------- Assignments & completions ----------
export const CreateAssignmentBodySchema = z
  .strictObject({
    studentId: Uuid.meta({ description: "A student of one of the teacher's classes." }),
    activityId: Uuid.meta({ description: 'An active (not archived) activity.' }),
  })
  .meta({ id: 'CreateAssignmentRequest' });
export type CreateAssignmentBody = z.output<typeof CreateAssignmentBodySchema>;

export const CreateCompletionBodySchema = z
  .strictObject({ assignmentId: Uuid, answer: ActivityAnswerSchema })
  .meta({ id: 'CreateCompletionRequest' });
export type CreateCompletionBody = z.output<typeof CreateCompletionBodySchema>;

export const StudentIdParamsSchema = z.strictObject({ studentId: Uuid.meta({ description: 'Student user ID (UUID).' }) });

export const ListAssignmentsQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  isDone: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .meta({ description: '"true" = completed only, "false" = still to do.' }),
});
export type ListAssignmentsQuery = z.output<typeof ListAssignmentsQuerySchema>;

const CompletionSchema = z.object({ answer: ActivityAnswerSchema, completedAt: Iso });

/** Teacher / psychologist view of a student's assignment (includes the answer). */
export const StaffAssignmentSchema = z
  .object({
    id: Id,
    studentId: Id,
    activity: z.object({ id: Id, title: z.string(), type: z.enum(ActivityType) }),
    source: z.enum(['direct', 'recommended']),
    assignedBy: z.object({ id: Id, fullName: z.string() }),
    observationId: Id.nullable(),
    assignedAt: Iso,
    completion: CompletionSchema.nullable(),
  })
  .meta({ id: 'StaffAssignment' });
export type StaffAssignmentDto = z.output<typeof StaffAssignmentSchema>;

/** The student's own view: the activity to do and their own answer. */
export const StudentAssignmentSchema = z
  .object({
    id: Id,
    activity: z.object({ id: Id, title: z.string(), content: ActivityContentSchema }),
    assignedAt: Iso,
    isDone: z.boolean(),
    completion: CompletionSchema.nullable(),
  })
  .meta({ id: 'StudentAssignment' });
export type StudentAssignmentDto = z.output<typeof StudentAssignmentSchema>;

/** Parent view: the activity and whether it is done. Never the child's answer. */
export const FamilyAssignmentSchema = z
  .object({
    id: Id,
    title: z.string(),
    isDone: z.boolean(),
    assignedAt: Iso,
    completedAt: Iso.nullable().meta({ description: 'When the child finished it; null while still to do.' }),
  })
  .meta({ id: 'FamilyAssignment' });
export type FamilyAssignmentDto = z.output<typeof FamilyAssignmentSchema>;

export const StaffAssignmentResponseSchema = z.object({ assignment: StaffAssignmentSchema }).meta({ id: 'StaffAssignmentResponse' });
export const StaffAssignmentListResponseSchema = z
  .object({ assignments: z.array(StaffAssignmentSchema), pagination: PaginationSchema })
  .meta({ id: 'StaffAssignmentListResponse' });
export const StudentAssignmentListResponseSchema = z
  .object({ assignments: z.array(StudentAssignmentSchema), pagination: PaginationSchema })
  .meta({ id: 'StudentAssignmentListResponse' });
export const FamilyAssignmentListResponseSchema = z
  .object({ assignments: z.array(FamilyAssignmentSchema), pagination: PaginationSchema })
  .meta({ id: 'FamilyAssignmentListResponse' });

export const CompletionResponseSchema = z
  .object({ completion: z.object({ id: Id, assignmentId: Id, answer: ActivityAnswerSchema, completedAt: Iso }) })
  .meta({ id: 'CompletionResponse' });
