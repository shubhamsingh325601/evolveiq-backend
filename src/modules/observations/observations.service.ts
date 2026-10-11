// Business rules for observations. No HTTP, no SQL.
//
//   Parent        writes observations about their own (linked) children; reads only what they
//                 wrote, with its status — nothing clinical.
//   Teacher       writes observations about students of their classes (optionally with Level
//                 and learning-behaviour area); reads only what they wrote, with its status and
//                 the psychologist's teacher-only note.
//   Psychologist  reads every observation (queue + filters, detail, history) and reviews:
//                 one review per observation (again → 409); a Significant observation needs a
//                 development area; "assigned" creates recommended assignments in the same
//                 transaction.
//
// Each audience has its own mapper below. They COPY the allowed fields one by one — never
// spread a record and delete fields — so a new column can't leak by default.
import { Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { StudentScopeRepository } from '../users/student-scope.js';
import type { ObservationRecord, ObservationsRepository } from './observations.repository.js';
import type {
  ListOwnObservationsQuery,
  ParentObservationBody,
  ParentObservationDto,
  ReviewBody,
  ReviewObservationDto,
  ReviewQueueQuery,
  TeacherObservationBody,
  TeacherObservationDto,
} from './observations.schemas.js';

const HISTORY_SIZE = 20;

export function toParentDto(o: ObservationRecord): ParentObservationDto {
  return {
    id: o.id,
    studentId: o.studentId,
    area: o.area,
    description: o.description,
    when: o.observedWhen,
    howOften: o.frequency,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
  };
}

export function toTeacherDto(o: ObservationRecord): TeacherObservationDto {
  return {
    id: o.id,
    studentId: o.studentId,
    area: o.area,
    description: o.description,
    when: o.observedWhen,
    howOften: o.frequency,
    level: o.level,
    learningBehaviourArea: o.learningBehaviourArea,
    status: o.status,
    teacherOnlyNote: o.teacherOnlyNote,
    reviewedAt: o.reviewedAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
  };
}

export function toReviewDto(o: ObservationRecord): ReviewObservationDto {
  const isReviewed = o.status === 'reviewed' && o.reviewOutcome && o.reviewedBy && o.reviewedAt;
  return {
    id: o.id,
    schoolId: o.schoolId,
    student: { id: o.student.id, fullName: o.student.fullName },
    author: { id: o.author.id, fullName: o.author.fullName, role: o.authorRole === 'parent' ? 'parent' : 'teacher' },
    area: o.area,
    description: o.description,
    when: o.observedWhen,
    howOften: o.frequency,
    level: o.level,
    learningBehaviourArea: o.learningBehaviourArea,
    status: o.status,
    review: isReviewed
      ? {
          outcome: o.reviewOutcome!,
          developmentArea: o.developmentArea,
          teacherOnlyNote: o.teacherOnlyNote,
          reviewedBy: { id: o.reviewedBy!.id, fullName: o.reviewedBy!.fullName },
          reviewedAt: o.reviewedAt!.toISOString(),
          activityIds: o.assignments.map((a) => a.activityId),
        }
      : null,
    createdAt: o.createdAt.toISOString(),
  };
}

export function createObservationsService(deps: { repository: ObservationsRepository; students: StudentScopeRepository }) {
  const { repository, students } = deps;

  /** The student, if the author may write about them (parent: own child; teacher: own class). */
  async function studentFor(actor: Actor, studentId: string) {
    const student = await students.findStudent(actor, studentId);
    if (!student || student.schoolId === null) throw Errors.invalidReference('studentId', 'Student not found.');
    return { ...student, schoolId: student.schoolId };
  }

  async function createAsParent(actor: Actor, body: ParentObservationBody): Promise<ParentObservationDto> {
    if (actor.role !== Role.Parent) throw Errors.forbidden();
    const student = await studentFor(actor, body.studentId);
    const created = await repository.create({
      schoolId: student.schoolId,
      studentId: student.id,
      authorId: actor.userId,
      authorRole: 'parent',
      area: body.area,
      description: body.description.trim(),
      observedWhen: body.when,
      frequency: body.howOften,
      level: null,
      learningBehaviourArea: null,
    });
    return toParentDto(created);
  }

  async function createAsTeacher(actor: Actor, body: TeacherObservationBody): Promise<TeacherObservationDto> {
    if (actor.role !== Role.Teacher) throw Errors.forbidden();
    const student = await studentFor(actor, body.studentId);
    const created = await repository.create({
      schoolId: student.schoolId,
      studentId: student.id,
      authorId: actor.userId,
      authorRole: 'teacher',
      area: body.area,
      description: body.description.trim(),
      observedWhen: body.when,
      frequency: body.howOften,
      level: body.level ?? null,
      learningBehaviourArea: body.learningBehaviourArea ?? null,
    });
    return toTeacherDto(created);
  }

  /** Observations the caller wrote — whatever their role, never anyone else's. */
  async function listOwn(actor: Actor, query: ListOwnObservationsQuery) {
    const { page, limit, status } = query;
    const { items, total } = await repository.list(
      { authorId: actor.userId, status },
      { skip: (page - 1) * limit, take: limit, sortOrder: 'desc' },
    );
    return { items, pagination: buildPagination(page, limit, total) };
  }

  async function listOwnAsParent(actor: Actor, query: ListOwnObservationsQuery): Promise<{ observations: ParentObservationDto[]; pagination: Pagination }> {
    if (actor.role !== Role.Parent) throw Errors.forbidden();
    const { items, pagination } = await listOwn(actor, query);
    return { observations: items.map(toParentDto), pagination };
  }

  async function listOwnAsTeacher(actor: Actor, query: ListOwnObservationsQuery): Promise<{ observations: TeacherObservationDto[]; pagination: Pagination }> {
    if (actor.role !== Role.Teacher) throw Errors.forbidden();
    const { items, pagination } = await listOwn(actor, query);
    return { observations: items.map(toTeacherDto), pagination };
  }

  // ---------- Psychologist ----------
  function assertPsychologist(actor: Actor): void {
    if (actor.role !== Role.Psychologist) throw Errors.forbidden();
  }

  async function queue(actor: Actor, query: ReviewQueueQuery): Promise<{ observations: ReviewObservationDto[]; pagination: Pagination }> {
    assertPsychologist(actor);
    const { page, limit, sortOrder, ...filters } = query;
    const { items, total } = await repository.list(filters, { skip: (page - 1) * limit, take: limit, sortOrder });
    return { observations: items.map(toReviewDto), pagination: buildPagination(page, limit, total) };
  }

  async function detail(actor: Actor, id: string): Promise<{ observation: ReviewObservationDto; history: ReviewObservationDto[] }> {
    assertPsychologist(actor);
    const observation = await repository.findById(id);
    if (!observation) throw Errors.notFound('Observation');
    const history = await repository.history(observation.studentId, observation.id, HISTORY_SIZE);
    return { observation: toReviewDto(observation), history: history.map(toReviewDto) };
  }

  async function review(actor: Actor, id: string, body: ReviewBody): Promise<ReviewObservationDto> {
    assertPsychologist(actor);
    const observation = await repository.findById(id);
    if (!observation) throw Errors.notFound('Observation');
    if (observation.status !== 'pending') throw Errors.conflict('This observation has already been reviewed.');
    if (observation.level === 'significant' && body.developmentArea === undefined) {
      throw Errors.validation([{ field: 'developmentArea', message: 'is required for Significant observations' }]);
    }

    const result = await repository.review({
      observationId: id,
      reviewerId: actor.userId,
      outcome: body.outcome,
      developmentArea: body.developmentArea ?? null,
      teacherOnlyNote: body.teacherOnlyNote?.trim() ?? null,
      activityIds: body.outcome === 'assigned' ? body.activityIds : [],
    });
    // Re-checked under the row lock: a concurrent review may have won in between.
    if (result === 'not_found') throw Errors.notFound('Observation');
    if (result === 'already_reviewed') throw Errors.conflict('This observation has already been reviewed.');
    if (result === 'invalid_activities') {
      throw Errors.invalidReference('activityIds', 'Every activity must exist and not be archived.');
    }

    const reviewed = await repository.findById(id);
    if (!reviewed) throw new Error('review: observation disappeared');
    return toReviewDto(reviewed);
  }

  return { createAsParent, createAsTeacher, listOwnAsParent, listOwnAsTeacher, queue, detail, review };
}

export type ObservationsService = ReturnType<typeof createObservationsService>;
