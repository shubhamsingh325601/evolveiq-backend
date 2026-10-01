// Zod schemas for the school routes — validated at the route boundary.
import { z } from 'zod';

// Non-blank, no control characters (same rule as a user's full name).
const SCHOOL_NAME = /^[^\u0000-\u001F\u007F]*[^\s\u0000-\u001F\u007F][^\u0000-\u001F\u007F]*$/u;

/** 1–200 characters after trimming (matches the schools.name CHECK constraint). */
export const SchoolNameSchema = z
  .string()
  .max(200)
  .regex(SCHOOL_NAME, 'must not be blank or contain control characters')
  .meta({ example: 'Sunrise Public School' });

export const CreateSchoolBodySchema = z
  .strictObject({ name: SchoolNameSchema })
  .meta({ id: 'CreateSchoolRequest' });

export const RenameSchoolBodySchema = z
  .strictObject({ name: SchoolNameSchema })
  .meta({ id: 'RenameSchoolRequest' });

export const SchoolIdParamsSchema = z.strictObject({
  schoolId: z.guid().meta({ description: 'School ID (UUID).', example: '11111111-1111-4111-8111-111111111111' }),
});

// ---------- List query ----------
export const PAGINATION = Object.freeze({ defaultPage: 1, defaultLimit: 20, maxLimit: 100, maxPage: 10_000 });

/** Sortable fields — an allowlist. Nothing outside it can reach the ORDER BY. */
export const SCHOOL_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;
export type SchoolSortField = (typeof SCHOOL_SORT_FIELDS)[number];
export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

// Query-string values arrive as strings. Accept plain decimal integers only — no "1e3",
// "0x10", " 5", "1.0" or repeated keys — then range-check the number.
const positiveInt = (label: string, max: number, fallback: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]{0,8}$/, `${label} must be a positive integer`)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max, `${label} must be at most ${max}`))
    .default(fallback)
    // Document it as the integer it is (the string pattern is an implementation detail).
    .meta({
      description: `${label}: integer 1–${max} (default ${fallback}).`,
      type: 'integer',
      minimum: 1,
      maximum: max,
      default: fallback,
      pattern: undefined,
    });

export const ListSchoolsQuerySchema = z.strictObject({
  page: positiveInt('page', PAGINATION.maxPage, PAGINATION.defaultPage),
  limit: positiveInt('limit', PAGINATION.maxLimit, PAGINATION.defaultLimit),
  sortBy: z
    .enum(SCHOOL_SORT_FIELDS)
    .default('name')
    .meta({ description: 'Field to sort by (default "name"). Ties are broken by id.' }),
  sortOrder: z.enum(SORT_ORDERS).default('asc').meta({ description: 'Sort direction (default "asc").' }),
  name: z
    .string()
    .max(200)
    .transform((value) => value.trim() || undefined)
    .optional()
    .meta({ description: 'Case-insensitive "contains" filter on the school name. Empty = no filter.' }),
});

export type ListSchoolsQuery = z.output<typeof ListSchoolsQuerySchema>;

// ---------- Responses ----------
export const SchoolSchema = z
  .object({
    id: z.string().meta({ format: 'uuid' }),
    name: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'School' });

export type SchoolDto = z.output<typeof SchoolSchema>;

export const PaginationSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int().meta({ description: 'Schools matching the filter, across all pages.' }),
    totalPages: z.number().int(),
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
  })
  .meta({ id: 'Pagination' });

export type Pagination = z.output<typeof PaginationSchema>;

export const SchoolResponseSchema = z.object({ school: SchoolSchema }).meta({ id: 'SchoolResponse' });

export const SchoolListResponseSchema = z
  .object({ schools: z.array(SchoolSchema), pagination: PaginationSchema })
  .meta({ id: 'SchoolListResponse' });
