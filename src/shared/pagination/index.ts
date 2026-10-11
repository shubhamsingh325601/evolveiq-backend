// The RecordsTable list pattern shared by every list endpoint (SCOPE_OF_WORK.md):
// `page` / `limit` query parameters, an allowlisted sort, and the same pagination metadata.
// Pagination, sorting and filtering always happen in the database.
import { z } from 'zod';

export const PAGINATION = Object.freeze({ defaultPage: 1, defaultLimit: 20, maxLimit: 100, maxPage: 10_000 });

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

// Query-string values arrive as strings. Accept plain decimal integers only — no "1e3",
// "0x10", " 5", "1.0" or repeated keys — then range-check the number.
export const positiveInt = (label: string, max: number, fallback: number) =>
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

/** `page` and `limit` query fields, to spread into a list query schema. */
export const PAGE_QUERY_FIELDS = {
  page: positiveInt('page', PAGINATION.maxPage, PAGINATION.defaultPage),
  limit: positiveInt('limit', PAGINATION.maxLimit, PAGINATION.defaultLimit),
};

export const PaginationSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int().meta({ description: 'Records matching the filter, across all pages.' }),
    totalPages: z.number().int(),
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
  })
  .meta({ id: 'Pagination' });

export type Pagination = z.output<typeof PaginationSchema>;

export function buildPagination(page: number, limit: number, total: number): Pagination {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/** Prisma's `contains` does not escape LIKE wildcards; make % and _ match literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
