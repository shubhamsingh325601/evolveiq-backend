// Zod schemas for the IT Help Desk — a gap found against the client's UI prototype (16 Nov
// 2026), not yet a confirmed client request; built so the project is ready to demo. A ticket
// always belongs to the school it was raised in; School Admins manage their own school's
// tickets, Platform Admins any.
import { z } from 'zod';
import { SupportTicketStatus } from '../../generated/prisma/enums.js';
import { PAGE_QUERY_FIELDS, PaginationSchema } from '../../shared/pagination/index.js';

export { SupportTicketStatus };

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;
const freeText = (max: number) => z.string().max(max).regex(FREE_TEXT, 'must not be blank or contain control characters');

export const SupportTicketIdParamsSchema = z.strictObject({ ticketId: Uuid });

export const ListSupportTicketsQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  schoolId: Uuid.optional().meta({ description: 'Platform Admins only: one school’s tickets.' }),
});
export type ListSupportTicketsQuery = z.output<typeof ListSupportTicketsQuerySchema>;

const fields = {
  subject: freeText(120),
  body: freeText(2000).meta({ description: 'The problem, in plain words.' }),
  status: z.enum(SupportTicketStatus),
};

export const CreateSupportTicketBodySchema = z
  .strictObject({
    subject: fields.subject,
    body: fields.body.optional(),
  })
  .meta({ id: 'CreateSupportTicketBody' });
export type CreateSupportTicketBody = z.output<typeof CreateSupportTicketBodySchema>;

export const UpdateSupportTicketStatusBodySchema = z
  .strictObject({ status: fields.status })
  .meta({ id: 'UpdateSupportTicketStatusBody' });
export type UpdateSupportTicketStatusBody = z.output<typeof UpdateSupportTicketStatusBodySchema>;

export const SupportTicketSchema = z
  .object({
    id: Id,
    schoolId: Id,
    schoolName: z.string(),
    subject: z.string(),
    body: z.string().nullable(),
    status: z.enum(SupportTicketStatus),
    raisedBy: z.object({ fullName: z.string() }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    canManage: z.boolean().meta({ description: 'Whether the caller may change its status.' }),
  })
  .meta({ id: 'SupportTicket' });
export type SupportTicketDto = z.output<typeof SupportTicketSchema>;

export const SupportTicketResponseSchema = z.object({ ticket: SupportTicketSchema }).meta({ id: 'SupportTicketResponse' });
export const SupportTicketListResponseSchema = z
  .object({ tickets: z.array(SupportTicketSchema).meta({ description: 'Newest first.' }), pagination: PaginationSchema })
  .meta({ id: 'SupportTicketListResponse' });
