// Business rules for classes. No HTTP, no SQL.
//
//   School Admin  creates, renames and lists the classes of their own school, and assigns
//                 teachers and students to them. The school ALWAYS comes from their token.
//   Teacher       lists and views only the classes they are assigned to.
// A class has many teachers, a teacher many classes; a student belongs to one class.
// Class, teacher and student are always in the same school.
import { constraintViolation, Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { ClassRecord, ClassesRepository, Member } from './classes.repository.js';
import type { ClassBody, ClassDto, ListClassesQuery } from './classes.schemas.js';

const DUPLICATE_NAME = 'classes_school_id_name_key';

function toDto(c: ClassRecord): ClassDto {
  return {
    id: c.id,
    schoolId: c.schoolId,
    name: c.name,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** The caller's own school. School Admins and Teachers always have one; fail closed if not. */
function schoolOf(actor: Actor): string {
  if ((actor.role !== Role.SchoolAdmin && actor.role !== Role.Teacher) || actor.schoolId === null) {
    throw Errors.forbidden();
  }
  return actor.schoolId;
}

function adminSchoolOf(actor: Actor): string {
  if (actor.role !== Role.SchoolAdmin) throw Errors.forbidden();
  return schoolOf(actor);
}

/** Runs a write that may hit the per-school unique name; maps it to 409. */
async function withUniqueName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    const violation = constraintViolation(err);
    if (violation?.kind === 'unique' && violation.constraint === DUPLICATE_NAME) {
      throw Errors.conflict('A class with this name already exists in this school.');
    }
    throw err;
  }
}

export function createClassesService(deps: { repository: ClassesRepository }) {
  const { repository } = deps;

  async function create(actor: Actor, body: ClassBody): Promise<ClassDto> {
    const schoolId = adminSchoolOf(actor);
    return toDto(await withUniqueName(() => repository.create(schoolId, body.name.trim())));
  }

  async function rename(actor: Actor, classId: string, body: ClassBody): Promise<ClassDto> {
    const schoolId = adminSchoolOf(actor);
    const updated = await withUniqueName(() => repository.rename(classId, schoolId, body.name.trim()));
    if (!updated) throw Errors.notFound('Class');
    return toDto(updated);
  }

  async function list(actor: Actor, query: ListClassesQuery): Promise<{ classes: ClassDto[]; pagination: Pagination }> {
    const { page, limit, sortBy, sortOrder, name } = query;
    const { items, total } = await repository.list({
      schoolId: schoolOf(actor),
      teacherId: actor.role === Role.Teacher ? actor.userId : undefined,
      skip: (page - 1) * limit,
      take: limit,
      sortBy,
      sortOrder,
      nameContains: name,
    });
    return { classes: items.map(toDto), pagination: buildPagination(page, limit, total) };
  }

  /** Class + its teachers and students. Teachers only reach classes they are assigned to. */
  async function getDetail(actor: Actor, classId: string): Promise<{ class: ClassDto; teachers: Member[]; students: Member[] }> {
    const teacherId = actor.role === Role.Teacher ? actor.userId : undefined;
    const found = await repository.findInSchool(classId, schoolOf(actor), teacherId);
    if (!found) throw Errors.notFound('Class');
    return { class: toDto(found), ...(await repository.members(classId)) };
  }

  // Idempotent: assigning an already-assigned teacher succeeds.
  async function addTeacher(actor: Actor, classId: string, teacherId: string): Promise<void> {
    const row = await repository.addTeacher({ classId, teacherId, schoolId: adminSchoolOf(actor) });
    if (!row.is_class_found) throw Errors.notFound('Class');
    if (!row.is_member_found) throw Errors.notFound('Teacher');
  }

  async function removeTeacher(actor: Actor, classId: string, teacherId: string): Promise<void> {
    const isRemoved = await repository.removeTeacher({ classId, teacherId, schoolId: adminSchoolOf(actor) });
    if (!isRemoved) throw Errors.notFound('Class teacher');
  }

  // Idempotent for the student's current class; a student already in ANOTHER class → 409
  // (remove them from that class first).
  async function addStudent(actor: Actor, classId: string, studentId: string): Promise<void> {
    const row = await repository.addStudent({ classId, studentId, schoolId: adminSchoolOf(actor) });
    if (!row.is_class_found) throw Errors.notFound('Class');
    if (!row.is_member_found) throw Errors.notFound('Student');
    if (!row.is_inserted && row.current_class_id !== classId) {
      throw Errors.conflict('This student already belongs to another class.');
    }
  }

  async function removeStudent(actor: Actor, classId: string, studentId: string): Promise<void> {
    const isRemoved = await repository.removeStudent({ classId, studentId, schoolId: adminSchoolOf(actor) });
    if (!isRemoved) throw Errors.notFound('Class student');
  }

  // The students stay at the school, waiting for a class; their records are untouched.
  async function remove(actor: Actor, classId: string): Promise<void> {
    if (!(await repository.remove(classId, adminSchoolOf(actor)))) throw Errors.notFound('Class');
  }

  return { create, rename, list, getDetail, addTeacher, removeTeacher, addStudent, removeStudent, remove };
}

export type ClassesService = ReturnType<typeof createClassesService>;
