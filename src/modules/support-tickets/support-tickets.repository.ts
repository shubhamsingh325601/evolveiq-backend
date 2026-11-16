// Database access for the IT Help Desk. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { SupportTicketStatus } from '../../generated/prisma/enums.js';
import type { Db } from '../../shared/db/prisma.js';

const SUPPORT_TICKET = {
  id: true,
  schoolId: true,
  raisedById: true,
  subject: true,
  body: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  school: { select: { name: true } },
  raisedBy: { select: { fullName: true } },
} as const satisfies Prisma.SupportTicketSelect;
export type SupportTicketRecord = Prisma.SupportTicketGetPayload<{ select: typeof SUPPORT_TICKET }>;

export function createSupportTicketsRepository(db: Db) {
  return {
    async list(where: Prisma.SupportTicketWhereInput, skip: number, take: number): Promise<{ items: SupportTicketRecord[]; total: number }> {
      const [items, total] = await db.$transaction([
        db.supportTicket.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: SUPPORT_TICKET,
        }),
        db.supportTicket.count({ where }),
      ]);
      return { items, total };
    },

    find(id: string): Promise<SupportTicketRecord | null> {
      return db.supportTicket.findUnique({ where: { id }, select: SUPPORT_TICKET });
    },

    create(data: Prisma.SupportTicketUncheckedCreateInput): Promise<SupportTicketRecord> {
      return db.supportTicket.create({ data, select: SUPPORT_TICKET });
    },

    updateStatus(id: string, status: SupportTicketStatus): Promise<SupportTicketRecord> {
      return db.supportTicket.update({ where: { id }, data: { status }, select: SUPPORT_TICKET });
    },
  };
}

export type SupportTicketsRepository = ReturnType<typeof createSupportTicketsRepository>;
