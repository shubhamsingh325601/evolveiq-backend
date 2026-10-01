// All database access for schools (Prisma Client). No business rules here.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';
import { isPrismaKnownError } from '../../shared/errors/index.js';
import type { SchoolSortField, SortOrder } from './schools.schemas.js';

export interface SchoolRecord {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListSchoolsParams {
  readonly skip: number;
  readonly take: number;
  readonly sortBy: SchoolSortField;
  readonly sortOrder: SortOrder;
  readonly nameContains?: string | undefined;
}

const SELECT = { id: true, name: true, createdAt: true, updatedAt: true } as const satisfies Prisma.SchoolSelect;

// Allowlisted sort field → Prisma column. Even if a caller bypassed validation, only these
// keys can ever reach ORDER BY. The id tie-breaker makes page boundaries deterministic.
const ORDER_BY: Readonly<Record<SchoolSortField, (o: SortOrder) => Prisma.SchoolOrderByWithRelationInput[]>> = {
  name: (o) => [{ name: o }, { id: 'asc' }],
  createdAt: (o) => [{ createdAt: o }, { id: 'asc' }],
  updatedAt: (o) => [{ updatedAt: o }, { id: 'asc' }],
};

/** Prisma's `contains` does not escape LIKE wildcards; make % and _ match literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function createSchoolsRepository(db: Db) {
  return {
    create(name: string): Promise<SchoolRecord> {
      return db.school.create({ data: { name }, select: SELECT });
    },

    findById(id: string): Promise<SchoolRecord | null> {
      return db.school.findUnique({ where: { id }, select: SELECT });
    },

    /** Returns null when no school has this id. */
    async rename(id: string, name: string): Promise<SchoolRecord | null> {
      try {
        return await db.school.update({ where: { id }, data: { name }, select: SELECT });
      } catch (err) {
        if (isPrismaKnownError(err, 'P2025')) return null; // record to update not found
        throw err;
      }
    },

    /** One page + the total, filtered/sorted/paginated in the database (LIMIT/OFFSET). */
    async list(p: ListSchoolsParams): Promise<{ items: SchoolRecord[]; total: number }> {
      const orderBy = ORDER_BY[p.sortBy](p.sortOrder);
      const where: Prisma.SchoolWhereInput = p.nameContains
        ? { name: { contains: escapeLike(p.nameContains), mode: 'insensitive' } }
        : {};
      // Both queries in one transaction so the page and the total see the same snapshot of
      // committed data as far as Postgres READ COMMITTED allows, on one connection.
      const [items, total] = await db.$transaction([
        db.school.findMany({ where, orderBy, skip: p.skip, take: p.take, select: SELECT }),
        db.school.count({ where }),
      ]);
      return { items, total };
    },
  };
}

export type SchoolsRepository = ReturnType<typeof createSchoolsRepository>;
