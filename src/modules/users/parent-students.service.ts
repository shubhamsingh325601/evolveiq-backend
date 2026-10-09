// Business rules for parent ↔ student links. No HTTP, no SQL.
//
//   Platform Admin  links / unlinks / lists in any school (parent and student in the same school)
//   School Admin    the same, inside their own school only
//   Parent          lists their own children
// A student has at most one parent; a parent may have many children (PRD §6).
import { Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { ParentStudentRecord, ParentStudentsRepository } from './parent-students.repository.js';
import type {
  CreateParentStudentBody,
  ListParentStudentsQuery,
  ParentStudentDto,
} from './parent-students.schemas.js';

function toDto(l: ParentStudentRecord): ParentStudentDto {
  return {
    parent: { id: l.parent.id, fullName: l.parent.fullName },
    student: { id: l.student.id, fullName: l.student.fullName },
    createdAt: l.createdAt.toISOString(),
  };
}

/** The school an admin's link operations are confined to (null = any school). */
function adminSchool(actor: Actor): string | null {
  if (actor.role === Role.PlatformAdmin) return null;
  if (actor.role === Role.SchoolAdmin && actor.schoolId !== null) return actor.schoolId;
  throw Errors.forbidden();
}

export function createParentStudentsService(deps: { repository: ParentStudentsRepository }) {
  const { repository } = deps;

  async function link(actor: Actor, body: CreateParentStudentBody): Promise<ParentStudentDto> {
    const row = await repository.insertLink({ ...body, schoolId: adminSchool(actor) });
    if (!row.is_student_valid) throw Errors.invalidReference('studentId', 'Student not found in this school.');
    if (!row.is_parent_valid) throw Errors.invalidReference('parentId', 'Parent not found in this school.');
    if (!row.is_inserted) throw Errors.conflict('This student already has a parent.');
    const created = await repository.findLink(body.studentId);
    if (!created) throw new Error('link: inserted row not found');
    return toDto(created);
  }

  async function unlink(actor: Actor, studentId: string): Promise<void> {
    const isDeleted = await repository.deleteLink(studentId, adminSchool(actor));
    if (!isDeleted) throw Errors.notFound('Parent link');
  }

  async function list(actor: Actor, query: ListParentStudentsQuery): Promise<{ links: ParentStudentDto[]; pagination: Pagination }> {
    const { page, limit, parentId, studentId } = query;
    let scope: { schoolId?: string; parentId?: string };
    if (actor.role === Role.Parent) {
      // A parent only ever sees their own children, whatever they filter by.
      if (parentId !== undefined && parentId !== actor.userId) throw Errors.forbidden();
      scope = { parentId: actor.userId };
    } else {
      const schoolId = adminSchool(actor);
      scope = schoolId === null ? {} : { schoolId };
    }
    const { items, total } = await repository.list({
      parentId,
      studentId,
      ...scope,
      skip: (page - 1) * limit,
      take: limit,
    });
    return { links: items.map(toDto), pagination: buildPagination(page, limit, total) };
  }

  return { link, unlink, list };
}

export type ParentStudentsService = ReturnType<typeof createParentStudentsService>;
