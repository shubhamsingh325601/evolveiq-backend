// Database access for the celebration wall. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';

const HONOUR = {
  id: true,
  schoolId: true,
  kind: true,
  month: true,
  citation: true,
  createdAt: true,
  honoree: { select: { id: true, fullName: true, role: true, classLink: { select: { class: { select: { name: true } } } } } },
  awardedBy: { select: { fullName: true } },
} as const satisfies Prisma.HonourSelect;
export type HonourRecord = Prisma.HonourGetPayload<{ select: typeof HONOUR }>;

export function createHonoursRepository(db: Db) {
  return {
    async list(where: Prisma.HonourWhereInput, skip: number, take: number): Promise<{ items: HonourRecord[]; total: number }> {
      const [items, total] = await db.$transaction([
        db.honour.findMany({
          where,
          orderBy: [{ month: 'desc' }, { kind: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          skip,
          take,
          select: HONOUR,
        }),
        db.honour.count({ where }),
      ]);
      return { items, total };
    },

    /** The user, if they have `role` in `schoolId`. */
    findMember(userId: string, role: 'teacher' | 'student', schoolId: string): Promise<{ id: string } | null> {
      return db.user.findFirst({ where: { id: userId, role, schoolId }, select: { id: true } });
    },

    /** Unique violations (the same honour twice) propagate. */
    create(data: Prisma.HonourUncheckedCreateInput): Promise<HonourRecord> {
      return db.honour.create({ data, select: HONOUR });
    },

    async remove(id: string, schoolId: string): Promise<boolean> {
      const { count } = await db.honour.deleteMany({ where: { id, schoolId } });
      return count > 0;
    },
  };
}

export type HonoursRepository = ReturnType<typeof createHonoursRepository>;
