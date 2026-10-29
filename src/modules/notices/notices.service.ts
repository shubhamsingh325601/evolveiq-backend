// Business rules for the notice board. No HTTP, no SQL.
//
// Who reads what (a notice for every school has no school_id):
//   Platform Admin  every notice
//   School Admin    their school's notices and the ones for every school, whatever the audience
//   Teacher         the same, for everyone or staff
//   Psychologist    every school's notices for everyone or staff (they work across schools)
//   Parent/Student  their school's notices and the ones for every school, for everyone or families
// Who writes: a School Admin for their own school; a Platform Admin for one school or for every
//   school. Each manages only what they may write. An emergency contact always has a phone.
import type { Prisma } from '../../generated/prisma/client.js';
import { Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { NoticeRecord, NoticesRepository } from './notices.repository.js';
import type { CreateNoticeBody, ListNoticesQuery, NoticeAudience, NoticeDto, UpdateNoticeBody } from './notices.schemas.js';

const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const STAFF_AUDIENCES: NoticeAudience[] = ['everyone', 'staff'];
const FAMILY_AUDIENCES: NoticeAudience[] = ['everyone', 'families'];

function canManage(actor: Actor, notice: Pick<NoticeRecord, 'schoolId'>): boolean {
  if (actor.role === Role.PlatformAdmin) return true;
  return actor.role === Role.SchoolAdmin && actor.schoolId !== null && notice.schoolId === actor.schoolId;
}

export function toNoticeDto(actor: Actor, notice: NoticeRecord): NoticeDto {
  return {
    id: notice.id,
    schoolId: notice.schoolId,
    schoolName: notice.school?.name ?? null,
    category: notice.category,
    title: notice.title,
    body: notice.body,
    startsOn: notice.startsOn?.toISOString().slice(0, 10) ?? null,
    location: notice.location,
    phone: notice.phone,
    audience: notice.audience,
    isPinned: notice.isPinned,
    createdBy: { fullName: notice.createdBy.fullName },
    createdAt: notice.createdAt.toISOString(),
    updatedAt: notice.updatedAt.toISOString(),
    canManage: canManage(actor, notice),
  };
}

/** The notices `actor` may read. */
export function noticeScope(actor: Actor): Prisma.NoticeWhereInput {
  const ownOrEverySchool: Prisma.NoticeWhereInput =
    actor.schoolId === null ? { schoolId: null } : { OR: [{ schoolId: actor.schoolId }, { schoolId: null }] };
  switch (actor.role) {
    case Role.PlatformAdmin:
      return {};
    case Role.SchoolAdmin:
      return ownOrEverySchool;
    case Role.Teacher:
      return { AND: [ownOrEverySchool, { audience: { in: STAFF_AUDIENCES } }] };
    case Role.Psychologist:
      return { audience: { in: STAFF_AUDIENCES } };
    case Role.Parent:
    case Role.Student:
      return { AND: [ownOrEverySchool, { audience: { in: FAMILY_AUDIENCES } }] };
  }
}

const needsPhone = (category: string, phone: string | null | undefined) => category === 'emergency_contact' && !phone;

export function createNoticesService(deps: { repository: NoticesRepository }) {
  const { repository } = deps;

  async function list(actor: Actor, query: ListNoticesQuery): Promise<{ notices: NoticeDto[]; pagination: Pagination }> {
    if (query.schoolId !== undefined && actor.role !== Role.PlatformAdmin) {
      throw Errors.forbidden('Only Platform Admins can filter notices by school.');
    }
    const where: Prisma.NoticeWhereInput = {
      AND: [
        noticeScope(actor),
        ...(query.category ? [{ category: query.category }] : []),
        ...(query.schoolId ? [{ schoolId: query.schoolId }] : []),
      ],
    };
    const { items, total } = await repository.list(where, (query.page - 1) * query.limit, query.limit);
    return { notices: items.map((n) => toNoticeDto(actor, n)), pagination: buildPagination(query.page, query.limit, total) };
  }

  async function create(actor: Actor, body: CreateNoticeBody): Promise<NoticeDto> {
    let schoolId: string | null;
    if (actor.role === Role.SchoolAdmin) {
      if (actor.schoolId === null) throw Errors.forbidden();
      if (body.schoolId !== undefined && body.schoolId !== actor.schoolId) {
        throw Errors.forbidden('School Admins can only post notices for their own school.');
      }
      schoolId = actor.schoolId;
    } else if (actor.role === Role.PlatformAdmin) {
      schoolId = body.schoolId ?? null;
      if (schoolId !== null && !(await repository.schoolExists(schoolId))) {
        throw Errors.invalidReference('schoolId', 'School not found.');
      }
    } else {
      throw Errors.forbidden();
    }
    if (needsPhone(body.category, body.phone)) {
      throw Errors.validation([{ field: 'phone', message: 'is required for an emergency contact' }]);
    }
    const notice = await repository.create({
      schoolId,
      category: body.category,
      title: body.title.trim(),
      body: body.body?.trim() ?? null,
      startsOn: body.startsOn ? asDate(body.startsOn) : null,
      location: body.location?.trim() ?? null,
      phone: body.phone?.trim() ?? null,
      audience: body.audience,
      isPinned: body.isPinned,
      createdById: actor.userId,
    });
    return toNoticeDto(actor, notice);
  }

  /** A notice the actor may manage; anything else (including one they can only read) is 404. */
  async function findManaged(actor: Actor, id: string): Promise<NoticeRecord> {
    const notice = await repository.find(id);
    if (!notice || !canManage(actor, notice)) throw Errors.notFound('Notice');
    return notice;
  }

  async function update(actor: Actor, id: string, body: UpdateNoticeBody): Promise<NoticeDto> {
    const current = await findManaged(actor, id);
    const category = body.category ?? current.category;
    const phone = body.phone === undefined ? current.phone : body.phone;
    if (needsPhone(category, phone)) {
      throw Errors.validation([{ field: 'phone', message: 'is required for an emergency contact' }]);
    }
    const nullable = (value: string | null | undefined) => (value === undefined ? undefined : (value?.trim() ?? null));
    const notice = await repository.update(id, {
      ...(body.category !== undefined && { category: body.category }),
      ...(body.title !== undefined && { title: body.title.trim() }),
      ...(body.body !== undefined && { body: nullable(body.body) }),
      ...(body.startsOn !== undefined && { startsOn: body.startsOn === null ? null : asDate(body.startsOn) }),
      ...(body.location !== undefined && { location: nullable(body.location) }),
      ...(body.phone !== undefined && { phone: nullable(body.phone) }),
      ...(body.audience !== undefined && { audience: body.audience }),
      ...(body.isPinned !== undefined && { isPinned: body.isPinned }),
    });
    return toNoticeDto(actor, notice);
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    await findManaged(actor, id);
    await repository.remove(id);
  }

  return { list, create, update, remove };
}

export type NoticesService = ReturnType<typeof createNoticesService>;
