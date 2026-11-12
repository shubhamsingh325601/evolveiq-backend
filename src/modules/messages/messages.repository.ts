// Database access for messages and the school contacts list. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';

export interface ContactRecord {
  readonly id: string;
  readonly fullName: string;
  readonly role: 'teacher' | 'psychologist' | 'school_admin';
}

export interface MessageRecord {
  readonly id: string;
  readonly studentId: string;
  readonly staffId: string;
  readonly senderId: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

export interface InboxMessageRecord extends MessageRecord {
  readonly student: { readonly fullName: string };
}

const MESSAGE = { id: true, studentId: true, staffId: true, senderId: true, body: true, createdAt: true, readAt: true } as const;
const CONTACT = { id: true, fullName: true, role: true } as const;
const THREAD_LIMIT = 200;
const INBOX_LIMIT = 500;

/** Active staff a family may write to: the child's class teachers, the school's admins, the counsellors. */
function contactFilter(studentId: string, schoolId: string | null): Prisma.UserWhereInput {
  const reachable: Prisma.UserWhereInput[] = [
    { role: 'teacher', teacherOf: { some: { class: { students: { some: { studentId } } } } } },
    { role: 'psychologist' },
  ];
  if (schoolId) reachable.push({ role: 'school_admin', schoolId });
  return { isActive: true, OR: reachable };
}

export function createMessagesRepository(db: Db) {
  return {
    contacts(studentId: string, schoolId: string | null): Promise<ContactRecord[]> {
      return db.user.findMany({
        where: contactFilter(studentId, schoolId),
        orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
        select: CONTACT,
      }) as Promise<ContactRecord[]>;
    },

    contact(studentId: string, schoolId: string | null, contactId: string): Promise<ContactRecord | null> {
      return db.user.findFirst({
        where: { AND: [{ id: contactId }, contactFilter(studentId, schoolId)] },
        select: CONTACT,
      }) as Promise<ContactRecord | null>;
    },

    /** A member of staff by id, for the staff side of a thread. */
    staffMember(staffId: string): Promise<ContactRecord | null> {
      return db.user.findFirst({
        where: { id: staffId, role: { in: ['teacher', 'psychologist', 'school_admin'] } },
        select: CONTACT,
      }) as Promise<ContactRecord | null>;
    },

    thread(studentId: string, staffId: string): Promise<MessageRecord[]> {
      return db.message.findMany({ where: { studentId, staffId }, orderBy: { createdAt: 'asc' }, take: THREAD_LIMIT, select: MESSAGE });
    },

    create(values: { studentId: string; staffId: string; senderId: string; body: string }): Promise<MessageRecord> {
      return db.message.create({ data: values, select: MESSAGE });
    },

    /** Marks the other side's unread messages in a thread as opened by `readerId`. */
    markRead(studentId: string, staffId: string, readerId: string, at: Date): Promise<unknown> {
      return db.message.updateMany({
        where: { studentId, staffId, readAt: null, senderId: { not: readerId } },
        data: { readAt: at },
      });
    },

    inbox(staffId: string): Promise<InboxMessageRecord[]> {
      return db.message.findMany({
        where: { staffId },
        orderBy: { createdAt: 'desc' },
        take: INBOX_LIMIT,
        select: { ...MESSAGE, student: { select: { fullName: true } } },
      });
    },
  };
}

export type MessagesRepository = ReturnType<typeof createMessagesRepository>;
