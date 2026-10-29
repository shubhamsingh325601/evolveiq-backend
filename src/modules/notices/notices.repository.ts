// Database access for the notice board. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';

const NOTICE = {
  id: true,
  schoolId: true,
  category: true,
  title: true,
  body: true,
  startsOn: true,
  location: true,
  phone: true,
  audience: true,
  isPinned: true,
  createdAt: true,
  updatedAt: true,
  school: { select: { name: true } },
  createdBy: { select: { fullName: true } },
} as const satisfies Prisma.NoticeSelect;
export type NoticeRecord = Prisma.NoticeGetPayload<{ select: typeof NOTICE }>;

export function createNoticesRepository(db: Db) {
  return {
    async list(where: Prisma.NoticeWhereInput, skip: number, take: number): Promise<{ items: NoticeRecord[]; total: number }> {
      const [items, total] = await db.$transaction([
        db.notice.findMany({
          where,
          orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: NOTICE,
        }),
        db.notice.count({ where }),
      ]);
      return { items, total };
    },

    find(id: string): Promise<NoticeRecord | null> {
      return db.notice.findUnique({ where: { id }, select: NOTICE });
    },

    schoolExists(id: string): Promise<boolean> {
      return db.school.count({ where: { id } }).then((n) => n > 0);
    },

    create(data: Prisma.NoticeUncheckedCreateInput): Promise<NoticeRecord> {
      return db.notice.create({ data, select: NOTICE });
    },

    update(id: string, data: Prisma.NoticeUncheckedUpdateInput): Promise<NoticeRecord> {
      return db.notice.update({ where: { id }, data, select: NOTICE });
    },

    async remove(id: string): Promise<void> {
      await db.notice.delete({ where: { id } });
    },
  };
}

export type NoticesRepository = ReturnType<typeof createNoticesRepository>;
