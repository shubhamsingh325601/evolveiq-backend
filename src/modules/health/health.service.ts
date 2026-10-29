// Business rules for health and care profiles. No HTTP, no SQL.
//
// Who (through the shared student scope, so the rules cannot drift from the rest of the API):
//   Parent        reads and writes their own children's profile
//   School Admin  reads and writes the profiles of their school's students
//   Teacher       reads the profiles of the students in their classes
//   Psychologist  reads any student's profile
// A student with nothing recorded reads as an empty profile (no 404), so a screen can always
// offer to fill it in. A profile is replaced whole on every write; it never feeds the
// Holistic Index.
import { Errors } from '../../shared/errors/index.js';
import type { Actor } from '../../shared/rbac/index.js';
import type { ClassScopeRepository } from '../schools/class-scope.js';
import type { StudentScopeRepository } from '../users/student-scope.js';
import type { HealthProfileRecord, HealthRepository } from './health.repository.js';
import type { BloodGroup, HealthProfileDto, PutHealthBody } from './health.schemas.js';

export function toHealthDto(profile: HealthProfileRecord): HealthProfileDto {
  return {
    studentId: profile.studentId,
    conditions: profile.conditions,
    bloodGroup: profile.bloodGroup as BloodGroup | null,
    allergies: profile.allergies,
    medications: profile.medications,
    careNotes: profile.careNotes,
    emergencyContact:
      profile.emergencyName !== null && profile.emergencyPhone !== null
        ? { name: profile.emergencyName, relation: profile.emergencyRelation, phone: profile.emergencyPhone }
        : null,
    updatedBy: profile.updatedBy ? { fullName: profile.updatedBy.fullName, role: profile.updatedBy.role } : null,
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function emptyProfile(studentId: string): HealthProfileDto {
  return {
    studentId,
    conditions: [],
    bloodGroup: null,
    allergies: null,
    medications: null,
    careNotes: null,
    emergencyContact: null,
    updatedBy: null,
    updatedAt: null,
  };
}

const trimmed = (value: string | null | undefined) => value?.trim() || null;

export function createHealthService(deps: { repository: HealthRepository; students: StudentScopeRepository; classes: ClassScopeRepository }) {
  const { repository, students, classes } = deps;

  async function requireStudent(actor: Actor, studentId: string): Promise<void> {
    if (!(await students.findStudent(actor, studentId))) throw Errors.notFound('Student');
  }

  async function get(actor: Actor, studentId: string): Promise<HealthProfileDto> {
    await requireStudent(actor, studentId);
    const profile = await repository.find(studentId);
    return profile ? toHealthDto(profile) : emptyProfile(studentId);
  }

  async function put(actor: Actor, studentId: string, body: PutHealthBody): Promise<HealthProfileDto> {
    await requireStudent(actor, studentId);
    const contact = body.emergencyContact ?? null;
    const profile = await repository.upsert(studentId, {
      conditions: body.conditions,
      bloodGroup: body.bloodGroup ?? null,
      allergies: trimmed(body.allergies),
      medications: trimmed(body.medications),
      careNotes: trimmed(body.careNotes),
      emergencyName: contact ? contact.name.trim() : null,
      emergencyRelation: contact ? trimmed(contact.relation) : null,
      emergencyPhone: contact ? contact.phone.trim() : null,
      updatedById: actor.userId,
    });
    return toHealthDto(profile);
  }

  async function forClass(actor: Actor, classId: string): Promise<HealthProfileDto[]> {
    if (!(await classes.findClass(actor, classId))) throw Errors.notFound('Class');
    return (await repository.forClass(classId)).map(toHealthDto);
  }

  return { get, put, forClass };
}

export type HealthService = ReturnType<typeof createHealthService>;
