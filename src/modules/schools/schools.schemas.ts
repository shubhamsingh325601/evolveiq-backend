// Zod schemas for the school routes — validated at the route boundary.
import { z } from 'zod';
import { PAGE_QUERY_FIELDS, PaginationSchema, SORT_ORDERS } from '../../shared/pagination/index.js';

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
// The shared RecordsTable list helpers; re-exported for existing importers of this module.
export { PAGINATION, SORT_ORDERS, type SortOrder } from '../../shared/pagination/index.js';

/** Sortable fields — an allowlist. Nothing outside it can reach the ORDER BY. */
export const SCHOOL_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;
export type SchoolSortField = (typeof SCHOOL_SORT_FIELDS)[number];

export const ListSchoolsQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
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

export { PaginationSchema, type Pagination } from '../../shared/pagination/index.js';

export const SchoolResponseSchema = z.object({ school: SchoolSchema }).meta({ id: 'SchoolResponse' });

export const SchoolListResponseSchema = z
  .object({ schools: z.array(SchoolSchema), pagination: PaginationSchema })
  .meta({ id: 'SchoolListResponse' });
