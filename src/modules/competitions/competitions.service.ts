// Business rules for Events & Competitions. No HTTP, no SQL.
//
// A competition always belongs to exactly one school (unlike Notice, there is no "every
// school" option). Who reads: Teachers, Psychologists and School Admins their own school's
// competitions only (a Psychologist has no school of their own, so that view is empty — they
// are not part of any one school's competition planning); Platform Admins every school's,
// filterable by schoolId.
// Who writes the competition itself: a School Admin for their own school; a Platform Admin for
// a named, existing school. Only School Admin (own school) / Platform Admin may edit or remove
// it — a competition out of the caller's scope is reported as missing (404), never leaked.
// Who nominates: a Teacher, for one of their own reachable students (the shared student scope),
// into a competition of their own school. A nomination is removed by the teacher who made it, or
// by School Admin (own school) / Platform Admin; a teacher trying to remove someone else's
// nomination is forbidden (403), mirroring how staff-reviews.service.ts phrases "not yours".
import type { Prisma } from '../../generated/prisma/client.js';
import { constraintViolation, Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { StudentScopeRepository } from '../users/student-scope.js';
import type { CompetitionRecord, CompetitionsRepository, NominationRecord } from './competitions.repository.js';
import type {
  CompetitionDto,
  CreateCompetitionBody,
  ListCompetitionsQuery,
  NominateBody,
  NominationDto,
  UpdateCompetitionBody,
} from './competitions.schemas.js';

const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

export function toCompetitionDto(competition: CompetitionRecord): CompetitionDto {
  return {
    id: competition.id,
    schoolId: competition.schoolId,
    title: competition.title,
    level: competition.level,
    status: competition.status,
    scheduledOn: competition.scheduledOn?.toISOString().slice(0, 10) ?? null,
    nominations: competition.nominations.map((n) => ({
      studentId: n.studentId,
      studentName: n.student.fullName,
      nominatedBy: { fullName: n.nominatedBy.fullName },
    })),
    createdBy: { fullName: competition.createdBy.fullName },
    createdAt: competition.createdAt.toISOString(),
    updatedAt: competition.updatedAt.toISOString(),
  };
}

function toNominationDto(nomination: NominationRecord): NominationDto {
  return {
    studentId: nomination.studentId,
    studentName: nomination.student.fullName,
    nominatedBy: { fullName: nomination.nominatedBy.fullName },
  };
}

function canManage(actor: Actor, competition: Pick<CompetitionRecord, 'schoolId'>): boolean {
  if (actor.role === Role.PlatformAdmin) return true;
  return actor.role === Role.SchoolAdmin && actor.schoolId !== null && competition.schoolId === actor.schoolId;
}

/** The competitions `actor` may list. */
function competitionScope(actor: Actor): Prisma.CompetitionWhereInput {
  if (actor.role === Role.PlatformAdmin) return {};
  // Teacher, Psychologist, School Admin: their own school only. A Psychologist has no school
  // of their own (ARCHITECTURE.md), so this is deliberately empty for them, same fail-closed
  // idiom as honours.service.ts and student-scope.ts use for a School Admin without one.
  if (actor.schoolId === null) return { id: { in: [] } };
  return { schoolId: actor.schoolId };
}

export function createCompetitionsService(deps: { repository: CompetitionsRepository; students: StudentScopeRepository }) {
  const { repository, students } = deps;

  async function list(actor: Actor, query: ListCompetitionsQuery): Promise<{ competitions: CompetitionDto[]; pagination: Pagination }> {
    if (query.schoolId !== undefined && actor.role !== Role.PlatformAdmin) {
      throw Errors.forbidden('Only Platform Admins can filter competitions by school.');
    }
    const where: Prisma.CompetitionWhereInput = {
      AND: [competitionScope(actor), ...(query.schoolId ? [{ schoolId: query.schoolId }] : [])],
    };
    const { items, total } = await repository.list(where, (query.page - 1) * query.limit, query.limit);
    return { competitions: items.map(toCompetitionDto), pagination: buildPagination(query.page, query.limit, total) };
  }

  async function create(actor: Actor, body: CreateCompetitionBody): Promise<CompetitionDto> {
    let schoolId: string;
    if (actor.role === Role.SchoolAdmin) {
      if (actor.schoolId === null) throw Errors.forbidden();
      if (body.schoolId !== undefined && body.schoolId !== actor.schoolId) {
        throw Errors.forbidden('School Admins can only create competitions for their own school.');
      }
      schoolId = actor.schoolId;
    } else if (actor.role === Role.PlatformAdmin) {
      if (body.schoolId === undefined) {
        throw Errors.validation([{ field: 'schoolId', message: 'is required' }]);
      }
      if (!(await repository.schoolExists(body.schoolId))) {
        throw Errors.invalidReference('schoolId', 'School not found.');
      }
      schoolId = body.schoolId;
    } else {
      throw Errors.forbidden();
    }
    const competition = await repository.create({
      schoolId,
      title: body.title.trim(),
      level: body.level,
      scheduledOn: body.scheduledOn ? asDate(body.scheduledOn) : null,
      createdById: actor.userId,
    });
    return toCompetitionDto(competition);
  }

  /** A competition the actor may manage; anything else (including one they can only read) is 404. */
  async function findManaged(actor: Actor, id: string): Promise<CompetitionRecord> {
    const competition = await repository.find(id);
    if (!competition || !canManage(actor, competition)) throw Errors.notFound('Competition');
    return competition;
  }

  async function update(actor: Actor, id: string, body: UpdateCompetitionBody): Promise<CompetitionDto> {
    await findManaged(actor, id);
    const competition = await repository.update(id, {
      ...(body.title !== undefined && { title: body.title.trim() }),
      ...(body.level !== undefined && { level: body.level }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.scheduledOn !== undefined && { scheduledOn: body.scheduledOn === null ? null : asDate(body.scheduledOn) }),
    });
    return toCompetitionDto(competition);
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    await findManaged(actor, id);
    await repository.remove(id);
  }

  async function nominate(actor: Actor, competitionId: string, body: NominateBody): Promise<NominationDto> {
    if (actor.role !== Role.Teacher) throw Errors.forbidden();
    const competition = await repository.find(competitionId);
    if (!competition || actor.schoolId === null || competition.schoolId !== actor.schoolId) {
      throw Errors.notFound('Competition');
    }
    const student = await students.findStudent(actor, body.studentId);
    if (!student) throw Errors.invalidReference('studentId', 'That student is not one of yours to nominate.');
    try {
      const nomination = await repository.createNomination({
        competitionId,
        studentId: student.id,
        nominatedById: actor.userId,
      });
      return toNominationDto(nomination);
    } catch (err) {
      if (constraintViolation(err)?.kind === 'unique') {
        throw Errors.conflict('This student has already been nominated for this competition.');
      }
      throw err;
    }
  }

  async function removeNomination(actor: Actor, competitionId: string, studentId: string): Promise<void> {
    if (actor.role === Role.Teacher) {
      const competition = await repository.find(competitionId);
      if (!competition || actor.schoolId === null || competition.schoolId !== actor.schoolId) {
        throw Errors.notFound('Competition');
      }
    } else {
      await findManaged(actor, competitionId);
    }
    const nomination = await repository.findNomination(competitionId, studentId);
    if (!nomination) throw Errors.notFound('Nomination');
    if (actor.role === Role.Teacher && nomination.nominatedById !== actor.userId) {
      throw Errors.forbidden('Teachers can only remove nominations they made.');
    }
    await repository.removeNomination(competitionId, studentId);
  }

  return { list, create, update, remove, nominate, removeNomination };
}

export type CompetitionsService = ReturnType<typeof createCompetitionsService>;
