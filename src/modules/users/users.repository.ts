// All database access for user management (Prisma Client). No business rules here.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';
import { constraintViolation, isPrismaKnownError } from '../../shared/errors/index.js';
import { escapeLike, type SortOrder } from '../../shared/pagination/index.js';
import type { Role } from '../../shared/rbac/index.js';
import type { UserSortField } from './users.schemas.js';

// Never selects secret_hash or the lockout columns.
const SELECT = {
  id: true,
  role: true,
  fullName: true,
  email: true,
  studentLoginId: true,
  schoolId: true,
  parentLink: { select: { parentId: true } },
  isActive: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

export type UserRecord = Prisma.UserGetPayload<{ select: typeof SELECT }>;

/** Fields an admin may change. Role and school are fixed at creation. */
export interface UserChanges {
  readonly fullName?: string | undefined;
  readonly email?: string | undefined;
  readonly studentLoginId?: string | undefined;
}

export interface ListUsersParams {
  readonly skip: number;
  readonly take: number;
  readonly sortBy: UserSortField;
  readonly sortOrder: SortOrder;
  /** Undefined = every school (and the school-less platform roles). */
  readonly schoolId?: string | undefined;
  /** Undefined = every role. */
  readonly roles?: readonly Role[] | undefined;
  readonly isActive?: boolean | undefined;
  readonly nameContains?: string | undefined;
}

// Allowlisted sort field → Prisma column, with an id tie-breaker for stable pages.
const ORDER_BY: Readonly<Record<UserSortField, (o: SortOrder) => Prisma.UserOrderByWithRelationInput[]>> = {
  fullName: (o) => [{ fullName: o }, { id: 'asc' }],
  createdAt: (o) => [{ createdAt: o }, { id: 'asc' }],
};

export function createUsersRepository(db: Db) {
  return {
    findById(id: string): Promise<UserRecord | null> {
      return db.user.findUnique({ where: { id }, select: SELECT });
    },

    /** One page + the total, filtered/sorted/paginated in the database (LIMIT/OFFSET). */
    async list(p: ListUsersParams): Promise<{ items: UserRecord[]; total: number }> {
      const where: Prisma.UserWhereInput = {
        ...(p.schoolId !== undefined && { schoolId: p.schoolId }),
        ...(p.roles !== undefined && { role: { in: [...p.roles] } }),
        ...(p.isActive !== undefined && { isActive: p.isActive }),
        ...(p.nameContains && { fullName: { contains: escapeLike(p.nameContains), mode: 'insensitive' } }),
      };
      const [items, total] = await db.$transaction([
        db.user.findMany({ where, orderBy: ORDER_BY[p.sortBy](p.sortOrder), skip: p.skip, take: p.take, select: SELECT }),
        db.user.count({ where }),
      ]);
      return { items, total };
    },

    /**
     * Marks the user inactive and revokes every live refresh token they hold, in one
     * transaction. Returns null when no user has this id.
     */
    async deactivate(id: string): Promise<UserRecord | null> {
      try {
        const [user] = await db.$transaction([
          db.user.update({ where: { id }, data: { isActive: false }, select: SELECT }),
          db.$executeRaw`
            UPDATE refresh_tokens SET revoked_at = now()
            WHERE user_id = ${id}::uuid AND revoked_at IS NULL`,
        ]);
        return user;
      } catch (err) {
        if (isPrismaKnownError(err, 'P2025')) return null; // record to update not found
        throw err;
      }
    },

    /**
     * Removes an account with the rows that only describe it: its class place, its parent
     * link, its health profile and its sessions. Anything that records what happened
     * (observations, activities, attendance, reviews…) points at the account with ON DELETE
     * RESTRICT, so such an account stays and this answers 'has_records'.
     */
    async remove(id: string): Promise<'removed' | 'missing' | 'has_records'> {
      try {
        await db.$transaction(async (tx) => {
          await tx.classStudent.deleteMany({ where: { studentId: id } });
          await tx.classTeacher.deleteMany({ where: { teacherId: id } });
          await tx.parentStudent.deleteMany({ where: { OR: [{ studentId: id }, { parentId: id }] } });
          await tx.user.delete({ where: { id } });
        });
        return 'removed';
      } catch (err) {
        if (isPrismaKnownError(err, 'P2025')) return 'missing';
        if (constraintViolation(err)?.kind === 'foreign_key' || isPrismaKnownError(err, 'P2014')) return 'has_records';
        throw err;
      }
    },

    /** Returns null when no user has this id. Login lockout state is left as it is. */
    async reactivate(id: string): Promise<UserRecord | null> {
      try {
        return await db.user.update({ where: { id }, data: { isActive: true }, select: SELECT });
      } catch (err) {
        if (isPrismaKnownError(err, 'P2025')) return null;
        throw err;
      }
    },

    /** Returns null when no user has this id. Unique violations (email, student ID) propagate. */
    async update(id: string, changes: UserChanges): Promise<UserRecord | null> {
      try {
        return await db.user.update({ where: { id }, data: { ...changes }, select: SELECT });
      } catch (err) {
        if (isPrismaKnownError(err, 'P2025')) return null;
        throw err;
      }
    },
  };
}

export type UsersRepository = ReturnType<typeof createUsersRepository>;
