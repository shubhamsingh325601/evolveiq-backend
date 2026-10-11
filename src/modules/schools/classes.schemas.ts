// Zod schemas for the class routes — validated at the route boundary.
import { z } from 'zod';
import { PAGE_QUERY_FIELDS, PaginationSchema, SORT_ORDERS } from '../../shared/pagination/index.js';

// Non-blank, no control characters (same rule as school and user names).
const CLASS_NAME = /^[^\u0000-\u001F\u007F]*[^\s\u0000-\u001F\u007F][^\u0000-\u001F\u007F]*$/u;
const Uuid = z.guid();

/** 1–100 characters after trimming (matches the classes.name CHECK constraint). */
const ClassNameSchema = z
  .string()
  .max(100)
  .regex(CLASS_NAME, 'must not be blank or contain control characters')
  .meta({ example: 'Grade 4 – B' });

/** The class's only field. Its school always comes from the caller's token, never the body. */
export const ClassBodySchema = z.strictObject({ name: ClassNameSchema }).meta({ id: 'ClassRequest' });
export type ClassBody = z.output<typeof ClassBodySchema>;

export const ClassIdParamsSchema = z.strictObject({ classId: Uuid.meta({ description: 'Class ID (UUID).' }) });
export const ClassTeacherParamsSchema = z.strictObject({ classId: Uuid, teacherId: Uuid });
export const ClassStudentParamsSchema = z.strictObject({ classId: Uuid, studentId: Uuid });

export const CLASS_SORT_FIELDS = ['name', 'createdAt'] as const;
export type ClassSortField = (typeof CLASS_SORT_FIELDS)[number];

export const ListClassesQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  sortBy: z.enum(CLASS_SORT_FIELDS).default('name').meta({ description: 'Field to sort by (default "name"). Ties are broken by id.' }),
  sortOrder: z.enum(SORT_ORDERS).default('asc'),
  name: z
    .string()
    .max(100)
    .transform((value) => value.trim() || undefined)
    .optional()
    .meta({ description: 'Case-insensitive "contains" filter on the class name. Empty = no filter.' }),
});

export type ListClassesQuery = z.output<typeof ListClassesQuerySchema>;

export const ClassSchema = z
  .object({
    id: z.string().meta({ format: 'uuid' }),
    schoolId: z.string().meta({ format: 'uuid' }),
    name: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Class' });

export type ClassDto = z.output<typeof ClassSchema>;

const MemberSchema = z.object({ id: z.string().meta({ format: 'uuid' }), fullName: z.string() });
export type MemberDto = z.output<typeof MemberSchema>;

export const ClassResponseSchema = z.object({ class: ClassSchema }).meta({ id: 'ClassResponse' });

export const ClassDetailResponseSchema = z
  .object({ class: ClassSchema, teachers: z.array(MemberSchema), students: z.array(MemberSchema) })
  .meta({ id: 'ClassDetailResponse' });

export const ClassListResponseSchema = z
  .object({ classes: z.array(ClassSchema), pagination: PaginationSchema })
  .meta({ id: 'ClassListResponse' });
