// Zod schemas for parent <-> school messages (the Connect tab).
//
// A thread is one child and one member of school staff. Parents start threads with the people
// the school lists as contacts; staff reply. Short notes, not a chat: no attachments, no groups.
import { z } from 'zod';

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });

export const MESSAGE_MAX_LENGTH = 1000;

export const StudentIdParamsSchema = z.strictObject({ studentId: Uuid.meta({ description: 'Student user ID (UUID).' }) });
export const ThreadQuerySchema = z.strictObject({ contactId: Uuid.meta({ description: 'The staff member the thread is with.' }) });

export const SendFamilyMessageBodySchema = z
  .strictObject({
    contactId: Uuid.meta({ description: 'A person from the contacts list.' }),
    body: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH),
  })
  .meta({ id: 'SendFamilyMessageBody' });
export type SendFamilyMessageBody = z.output<typeof SendFamilyMessageBodySchema>;

export const ReplyBodySchema = z
  .strictObject({ body: z.string().trim().min(1).max(MESSAGE_MAX_LENGTH) })
  .meta({ id: 'ReplyBody' });
export type ReplyBody = z.output<typeof ReplyBodySchema>;

export const CONTACT_ROLES = ['teacher', 'psychologist', 'school_admin'] as const;

export const ContactSchema = z
  .object({
    id: Id,
    fullName: z.string(),
    role: z.enum(CONTACT_ROLES),
  })
  .meta({ id: 'SchoolContact' });
export type ContactDto = z.output<typeof ContactSchema>;
export const ContactsResponseSchema = z.object({ contacts: z.array(ContactSchema) }).meta({ id: 'SchoolContactsResponse' });

export const MessageSchema = z
  .object({
    id: Id,
    body: z.string(),
    fromParent: z.boolean().meta({ description: 'true when the parent wrote it, false when school staff did.' }),
    at: z.iso.datetime(),
  })
  .meta({ id: 'Message' });
export type MessageDto = z.output<typeof MessageSchema>;

export const ThreadResponseSchema = z
  .object({
    studentId: Id,
    studentName: z.string(),
    contact: ContactSchema,
    messages: z.array(MessageSchema).meta({ description: 'Oldest first.' }),
  })
  .meta({ id: 'MessageThread' });
export type ThreadDto = z.output<typeof ThreadResponseSchema>;

export const SentResponseSchema = z.object({ message: MessageSchema }).meta({ id: 'MessageResponse' });

export const InboxItemSchema = z
  .object({
    studentId: Id,
    studentName: z.string(),
    lastMessage: MessageSchema,
    unreadCount: z.number().int().meta({ description: 'Parent messages the staff member has not opened yet.' }),
  })
  .meta({ id: 'InboxItem' });
export type InboxItemDto = z.output<typeof InboxItemSchema>;
export const InboxResponseSchema = z
  .object({ threads: z.array(InboxItemSchema).meta({ description: 'Newest activity first.' }), unreadCount: z.number().int() })
  .meta({ id: 'MessageInbox' });
