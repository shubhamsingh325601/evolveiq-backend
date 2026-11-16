// Business rules for the Staff Training & Development Hub. No HTTP, no SQL.
//
// A gap found against the client's prototype — not yet confirmed scope (SCOPE_OF_WORK.md,
// 16 Nov 2026). Deliberately a dumb CRUD list of two things, trainings and who's enrolled in
// them: no completion rate, no "X% of staff" number (SCOPE_OF_WORK.md forbids analytics
// endpoints). That number is the frontend's job, computed from these same list endpoints,
// exactly like this backend's other admin-dashboard KPI tiles.
//
// Who reads what (a training for every school has no school_id):
//   Platform Admin, Psychologist   every training (they work across schools)
//   School Admin, Teacher          their school's trainings and the ones for every school
// Who writes: a School Admin for their own school; a Platform Admin for one school or for every
//   school. Each manages only what they may write.
// Who enrols: a Teacher or Psychologist, in a training they can see, once each; they mark their
//   own enrolment complete. Nobody sees another staff member's enrolment.
import type { Prisma } from '../../generated/prisma/client.js';
import { constraintViolation, Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { EnrolmentRecord, TrainingRecord, TrainingsRepository } from './trainings.repository.js';
import type { CreateTrainingBody, EnrolmentDto, ListTrainingsQuery, TrainingDto, UpdateTrainingBody } from './trainings.schemas.js';

const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const ENROLMENT_DUPLICATE = 'training_enrolments_training_id_staff_id_key';

function canManage(actor: Actor, training: Pick<TrainingRecord, 'schoolId'>): boolean {
  if (actor.role === Role.PlatformAdmin) return true;
  return actor.role === Role.SchoolAdmin && actor.schoolId !== null && training.schoolId === actor.schoolId;
}

/** Whether `actor` may see this one training: their school, every-school, or a cross-school role. */
function isVisible(actor: Actor, training: Pick<TrainingRecord, 'schoolId'>): boolean {
  if (actor.role === Role.PlatformAdmin || actor.role === Role.Psychologist) return true;
  if (training.schoolId === null) return true;
  return actor.schoolId !== null && training.schoolId === actor.schoolId;
}

export function toTrainingDto(actor: Actor, training: TrainingRecord, myEnrolment: EnrolmentRecord | null): TrainingDto {
  return {
    id: training.id,
    schoolId: training.schoolId,
    schoolName: training.school?.name ?? null,
    title: training.title,
    description: training.description,
    scheduledOn: training.scheduledOn?.toISOString().slice(0, 10) ?? null,
    requirement: training.requirement,
    credits: training.credits,
    createdBy: { fullName: training.createdBy.fullName },
    createdAt: training.createdAt.toISOString(),
    updatedAt: training.updatedAt.toISOString(),
    canManage: canManage(actor, training),
    myEnrolment: myEnrolment ? { isComplete: myEnrolment.isComplete } : null,
  };
}

/** The trainings `actor` may read. */
export function trainingScope(actor: Actor): Prisma.TrainingWhereInput {
  switch (actor.role) {
    case Role.PlatformAdmin:
    case Role.Psychologist:
      return {};
    case Role.SchoolAdmin:
    case Role.Teacher:
      return actor.schoolId === null ? { schoolId: null } : { OR: [{ schoolId: actor.schoolId }, { schoolId: null }] };
    default:
      return { id: { in: [] } };
  }
}

export function createTrainingsService(deps: { repository: TrainingsRepository; now: () => Date }) {
  const { repository, now } = deps;

  async function list(actor: Actor, query: ListTrainingsQuery): Promise<{ trainings: TrainingDto[]; pagination: Pagination }> {
    if (query.schoolId !== undefined && actor.role !== Role.PlatformAdmin) {
      throw Errors.forbidden('Only Platform Admins can filter trainings by school.');
    }
    const where: Prisma.TrainingWhereInput = {
      AND: [
        trainingScope(actor),
        ...(query.requirement ? [{ requirement: query.requirement }] : []),
        ...(query.schoolId ? [{ schoolId: query.schoolId }] : []),
      ],
    };
    const { items, total } = await repository.list(where, (query.page - 1) * query.limit, query.limit);
    const myEnrolments = await repository.myEnrolments(
      actor.userId,
      items.map((t) => t.id),
    );
    return {
      trainings: items.map((t) => toTrainingDto(actor, t, myEnrolments.get(t.id) ?? null)),
      pagination: buildPagination(query.page, query.limit, total),
    };
  }

  async function create(actor: Actor, body: CreateTrainingBody): Promise<TrainingDto> {
    let schoolId: string | null;
    if (actor.role === Role.SchoolAdmin) {
      if (actor.schoolId === null) throw Errors.forbidden();
      if (body.schoolId !== undefined && body.schoolId !== actor.schoolId) {
        throw Errors.forbidden('School Admins can only offer trainings for their own school.');
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
    const training = await repository.create({
      schoolId,
      title: body.title.trim(),
      description: body.description?.trim() ?? null,
      scheduledOn: body.scheduledOn ? asDate(body.scheduledOn) : null,
      requirement: body.requirement,
      credits: body.credits,
      createdById: actor.userId,
    });
    return toTrainingDto(actor, training, null);
  }

  /** A training the actor may manage; anything else (including one they can only read) is 404. */
  async function findManaged(actor: Actor, id: string): Promise<TrainingRecord> {
    const training = await repository.find(id);
    if (!training || !canManage(actor, training)) throw Errors.notFound('Training');
    return training;
  }

  async function update(actor: Actor, id: string, body: UpdateTrainingBody): Promise<TrainingDto> {
    await findManaged(actor, id);
    const nullable = (value: string | null | undefined) => (value === undefined ? undefined : (value?.trim() ?? null));
    const training = await repository.update(id, {
      ...(body.title !== undefined && { title: body.title.trim() }),
      ...(body.description !== undefined && { description: nullable(body.description) }),
      ...(body.scheduledOn !== undefined && { scheduledOn: body.scheduledOn === null ? null : asDate(body.scheduledOn) }),
      ...(body.requirement !== undefined && { requirement: body.requirement }),
      ...(body.credits !== undefined && { credits: body.credits }),
    });
    return toTrainingDto(actor, training, null);
  }

  async function remove(actor: Actor, id: string): Promise<void> {
    await findManaged(actor, id);
    await repository.remove(id);
  }

  async function enrol(actor: Actor, trainingId: string): Promise<EnrolmentDto> {
    const training = await repository.find(trainingId);
    if (!training || !isVisible(actor, training)) throw Errors.notFound('Training');
    try {
      const enrolment = await repository.enrol(trainingId, actor.userId, now());
      return { isComplete: enrolment.isComplete };
    } catch (err) {
      const violation = constraintViolation(err);
      if (violation?.kind === 'unique' && violation.constraint === ENROLMENT_DUPLICATE) {
        throw Errors.conflict('Already enrolled in this training.');
      }
      throw err;
    }
  }

  async function markComplete(actor: Actor, trainingId: string): Promise<EnrolmentDto> {
    const result = await repository.markComplete(trainingId, actor.userId, now());
    if (!result) throw Errors.notFound('Enrolment');
    return result;
  }

  return { list, create, update, remove, enrol, markComplete };
}

export type TrainingsService = ReturnType<typeof createTrainingsService>;
