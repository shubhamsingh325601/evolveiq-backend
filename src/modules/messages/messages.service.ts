// Business rules for parent <-> school messages. No HTTP, no SQL.
//
// A parent writes, about one of their children, to someone the school lists as a contact for that
// child (class teacher, counsellor, school admin). Staff reply in threads that exist; they cannot
// start one. Each side reads only its own threads, and opening a thread marks the other side's
// messages as read.
import { Errors } from '../../shared/errors/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { StudentScopeRepository } from '../users/student-scope.js';
import type { ContactRecord, MessageRecord, MessagesRepository } from './messages.repository.js';
import type { ContactDto, InboxItemDto, MessageDto, ReplyBody, SendFamilyMessageBody, ThreadDto } from './messages.schemas.js';

const toContact = (c: ContactRecord): ContactDto => ({ id: c.id, fullName: c.fullName, role: c.role });

/** The staff member of a thread is its one non-parent side: whatever they did not send, the parent did. */
const toMessage = (m: MessageRecord): MessageDto => ({
  id: m.id,
  body: m.body,
  fromParent: m.senderId !== m.staffId,
  at: m.createdAt.toISOString(),
});

export function createMessagesService(deps: {
  repository: MessagesRepository;
  students: StudentScopeRepository;
  now: () => Date;
}) {
  const { repository, students, now } = deps;

  async function requireStudent(actor: Actor, studentId: string) {
    const student = await students.findStudent(actor, studentId);
    if (!student) throw Errors.notFound('Student');
    return student;
  }

  const requireParent = (actor: Actor) => {
    if (actor.role !== Role.Parent) throw Errors.forbidden();
  };

  async function contacts(actor: Actor, studentId: string): Promise<ContactDto[]> {
    requireParent(actor);
    const student = await requireStudent(actor, studentId);
    return (await repository.contacts(student.id, student.schoolId)).map(toContact);
  }

  async function familyThread(actor: Actor, studentId: string, contactId: string): Promise<ThreadDto> {
    requireParent(actor);
    const student = await requireStudent(actor, studentId);
    const contact = await repository.contact(student.id, student.schoolId, contactId);
    if (!contact) throw Errors.notFound('Contact');
    await repository.markRead(student.id, contact.id, actor.userId, now());
    const messages = await repository.thread(student.id, contact.id);
    return { studentId: student.id, studentName: student.fullName, contact: toContact(contact), messages: messages.map(toMessage) };
  }

  async function send(actor: Actor, studentId: string, body: SendFamilyMessageBody): Promise<MessageDto> {
    requireParent(actor);
    const student = await requireStudent(actor, studentId);
    const contact = await repository.contact(student.id, student.schoolId, body.contactId);
    if (!contact) throw Errors.invalidReference('contactId', 'That person is not one of this child’s school contacts.');
    return toMessage(await repository.create({ studentId: student.id, staffId: contact.id, senderId: actor.userId, body: body.body }));
  }

  async function inbox(actor: Actor): Promise<{ threads: InboxItemDto[]; unreadCount: number }> {
    const records = await repository.inbox(actor.userId); // newest first
    const byStudent = new Map<string, InboxItemDto>();
    for (const m of records) {
      const unread = m.senderId !== m.staffId && m.readAt === null ? 1 : 0;
      const item = byStudent.get(m.studentId);
      if (item) item.unreadCount += unread;
      else byStudent.set(m.studentId, { studentId: m.studentId, studentName: m.student.fullName, lastMessage: toMessage(m), unreadCount: unread });
    }
    const threads = [...byStudent.values()];
    return { threads, unreadCount: threads.reduce((sum, t) => sum + t.unreadCount, 0) };
  }

  async function staffThread(actor: Actor, studentId: string): Promise<ThreadDto> {
    const student = await requireStudent(actor, studentId);
    const messages = await repository.thread(student.id, actor.userId);
    if (messages.length === 0) throw Errors.notFound('Thread');
    const me = await repository.staffMember(actor.userId);
    if (!me) throw Errors.forbidden();
    await repository.markRead(student.id, actor.userId, actor.userId, now());
    return { studentId: student.id, studentName: student.fullName, contact: toContact(me), messages: messages.map(toMessage) };
  }

  async function reply(actor: Actor, studentId: string, body: ReplyBody): Promise<MessageDto> {
    const student = await requireStudent(actor, studentId);
    const existing = await repository.thread(student.id, actor.userId);
    if (existing.length === 0) throw Errors.notFound('Thread'); // staff reply; they do not start threads
    return toMessage(await repository.create({ studentId: student.id, staffId: actor.userId, senderId: actor.userId, body: body.body }));
  }

  return { contacts, familyThread, send, inbox, staffThread, reply };
}
