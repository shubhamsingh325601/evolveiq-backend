// Business rules for the IT Help Desk — a gap found against the client's UI prototype (16 Nov
// 2026), not yet a confirmed client request; see docs/SCOPE_OF_WORK.md. No HTTP, no SQL.
//
// Who reads what:
//   Platform Admin   every ticket, any school
//   School Admin     every ticket of their own school
//   Teacher          only the tickets they raised
// Who writes: Teachers and School Admins raise a ticket for their own school, always starting
//   `open`. Only a School Admin (their own school) or a Platform Admin changes status; a ticket
//   outside the caller's scope is 404, never a leak. Psychologists are left out entirely (see
//   support-tickets.routes.ts): they have no school, and a ticket always belongs to one.
import type { Prisma } from '../../generated/prisma/client.js';
import { Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { SupportTicketRecord, SupportTicketsRepository } from './support-tickets.repository.js';
import type {
  CreateSupportTicketBody,
  ListSupportTicketsQuery,
  SupportTicketDto,
  UpdateSupportTicketStatusBody,
} from './support-tickets.schemas.js';

function canManage(actor: Actor, ticket: Pick<SupportTicketRecord, 'schoolId'>): boolean {
  if (actor.role === Role.PlatformAdmin) return true;
  return actor.role === Role.SchoolAdmin && actor.schoolId !== null && ticket.schoolId === actor.schoolId;
}

export function toSupportTicketDto(actor: Actor, ticket: SupportTicketRecord): SupportTicketDto {
  return {
    id: ticket.id,
    schoolId: ticket.schoolId,
    schoolName: ticket.school.name,
    subject: ticket.subject,
    body: ticket.body,
    status: ticket.status,
    raisedBy: { fullName: ticket.raisedBy.fullName },
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    canManage: canManage(actor, ticket),
  };
}

/** The tickets `actor` may read. */
export function ticketScope(actor: Actor): Prisma.SupportTicketWhereInput {
  switch (actor.role) {
    case Role.PlatformAdmin:
      return {};
    case Role.SchoolAdmin:
      return actor.schoolId === null ? { id: { in: [] } } : { schoolId: actor.schoolId };
    case Role.Teacher:
      return { raisedById: actor.userId };
    default:
      return { id: { in: [] } };
  }
}

export function createSupportTicketsService(deps: { repository: SupportTicketsRepository }) {
  const { repository } = deps;

  async function list(actor: Actor, query: ListSupportTicketsQuery): Promise<{ tickets: SupportTicketDto[]; pagination: Pagination }> {
    if (query.schoolId !== undefined && actor.role !== Role.PlatformAdmin) {
      throw Errors.forbidden('Only Platform Admins can filter support tickets by school.');
    }
    const where: Prisma.SupportTicketWhereInput = {
      AND: [ticketScope(actor), ...(query.schoolId ? [{ schoolId: query.schoolId }] : [])],
    };
    const { items, total } = await repository.list(where, (query.page - 1) * query.limit, query.limit);
    return { tickets: items.map((t) => toSupportTicketDto(actor, t)), pagination: buildPagination(query.page, query.limit, total) };
  }

  async function create(actor: Actor, body: CreateSupportTicketBody): Promise<SupportTicketDto> {
    // Teacher and School Admin always have a school (the route layer admits no one else here).
    if (actor.schoolId === null) throw Errors.forbidden();
    const ticket = await repository.create({
      schoolId: actor.schoolId,
      raisedById: actor.userId,
      subject: body.subject.trim(),
      body: body.body?.trim() ?? null,
      status: 'open',
    });
    return toSupportTicketDto(actor, ticket);
  }

  /** A ticket the actor may manage; anything else (unmanageable, or not reachable at all) is 404. */
  async function findManaged(actor: Actor, id: string): Promise<SupportTicketRecord> {
    const ticket = await repository.find(id);
    if (!ticket || !canManage(actor, ticket)) throw Errors.notFound('Support ticket');
    return ticket;
  }

  async function updateStatus(actor: Actor, id: string, body: UpdateSupportTicketStatusBody): Promise<SupportTicketDto> {
    await findManaged(actor, id);
    const ticket = await repository.updateStatus(id, body.status);
    return toSupportTicketDto(actor, ticket);
  }

  return { list, create, updateStatus };
}

export type SupportTicketsService = ReturnType<typeof createSupportTicketsService>;
