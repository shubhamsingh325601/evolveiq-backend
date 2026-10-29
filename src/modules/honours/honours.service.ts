// Business rules for the celebration wall. No HTTP, no SQL.
//
// Who names: the School Admin, for their own school — a teacher as Staff of the Month, a
//   student as Student of the Month (any number per month, each person once per kind).
// Who sees what:
//   School Admin, Teacher  their school's whole wall
//   Parent                 their school's Staff of the Month, and their own children's honours
//   Student                their school's Staff of the Month, and their own honours
//   Platform Admin         every school's wall
// A child's honour never reaches another family: students see no other student's data.
import type { Prisma } from '../../generated/prisma/client.js';
import { constraintViolation, Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import { businessMonth } from '../progress/business-time.js';
import type { HonourRecord, HonoursRepository } from './honours.repository.js';
import type { CreateHonourBody, HonourDto, ListHonoursQuery } from './honours.schemas.js';

const asMonthDate = (month: string) => new Date(`${month}-01T00:00:00.000Z`);
const DUPLICATE = 'honours_kind_month_honoree_id_key';

export function toHonourDto(honour: HonourRecord): HonourDto {
  return {
    id: honour.id,
    kind: honour.kind,
    month: honour.month.toISOString().slice(0, 7),
    honoree: {
      id: honour.honoree.id,
      fullName: honour.honoree.fullName,
      role: honour.kind === 'staff_of_month' ? 'teacher' : 'student',
      className: honour.honoree.classLink?.class.name ?? null,
    },
    citation: honour.citation,
    awardedBy: { fullName: honour.awardedBy.fullName },
    createdAt: honour.createdAt.toISOString(),
  };
}

/** The honours `actor` may see. */
export function honourScope(actor: Actor): Prisma.HonourWhereInput {
  if (actor.role === Role.PlatformAdmin) return {};
  if (actor.schoolId === null) return { id: { in: [] } };
  const school = { schoolId: actor.schoolId };
  switch (actor.role) {
    case Role.SchoolAdmin:
    case Role.Teacher:
      return school;
    case Role.Parent:
      return { ...school, OR: [{ kind: 'staff_of_month' }, { honoree: { parentLink: { parentId: actor.userId } } }] };
    case Role.Student:
      return { ...school, OR: [{ kind: 'staff_of_month' }, { honoreeId: actor.userId }] };
    default:
      return { id: { in: [] } };
  }
}

function adminSchoolOf(actor: Actor): string {
  if (actor.role !== Role.SchoolAdmin || actor.schoolId === null) throw Errors.forbidden();
  return actor.schoolId;
}

export function createHonoursService(deps: { repository: HonoursRepository; now: () => Date }) {
  const { repository, now } = deps;

  async function list(actor: Actor, query: ListHonoursQuery): Promise<{ honours: HonourDto[]; pagination: Pagination }> {
    if (query.schoolId !== undefined && actor.role !== Role.PlatformAdmin) {
      throw Errors.forbidden('Only Platform Admins can filter the wall by school.');
    }
    const where: Prisma.HonourWhereInput = {
      AND: [
        honourScope(actor),
        ...(query.month ? [{ month: asMonthDate(query.month) }] : []),
        ...(query.kind ? [{ kind: query.kind }] : []),
        ...(query.schoolId ? [{ schoolId: query.schoolId }] : []),
      ],
    };
    const { items, total } = await repository.list(where, (query.page - 1) * query.limit, query.limit);
    return { honours: items.map(toHonourDto), pagination: buildPagination(query.page, query.limit, total) };
  }

  async function create(actor: Actor, body: CreateHonourBody): Promise<HonourDto> {
    const schoolId = adminSchoolOf(actor);
    if (body.month > businessMonth(now())) throw Errors.validation([{ field: 'month', message: 'must not be in the future' }]);
    const role = body.kind === 'staff_of_month' ? 'teacher' : 'student';
    if (!(await repository.findMember(body.honoreeId, role, schoolId))) {
      throw Errors.invalidReference('honoreeId', `No ${role} with that ID in your school.`);
    }
    try {
      const honour = await repository.create({
        schoolId,
        kind: body.kind,
        month: asMonthDate(body.month),
        honoreeId: body.honoreeId,
        citation: body.citation.trim(),
        awardedById: actor.userId,
      });
      return toHonourDto(honour);
    } catch (err) {
      const violation = constraintViolation(err);
      if (violation?.kind === 'unique' && violation.constraint === DUPLICATE) {
        throw Errors.conflict('They already have this honour for that month.');
      }
      throw err;
    }
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    const schoolId = adminSchoolOf(actor);
    if (!(await repository.remove(id, schoolId))) throw Errors.notFound('Honour');
  }

  return { list, create, remove };
}

export type HonoursService = ReturnType<typeof createHonoursService>;
