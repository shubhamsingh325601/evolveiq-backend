// Business rules for the activity library, assignments and completions. No HTTP, no SQL.
//
// Library (one, global): Psychologists create, edit and archive (never delete). Teachers
//   browse active activities. Once an activity has been assigned its type and options are
//   frozen — archive it and create a new one instead.
// Assignments: Teachers assign directly ("direct") to students of their classes.
//   Psychologists assign only through an observation review ("recommended"; see the
//   observations module). No due dates, reattempts or cancellation.
// Completions: a student answers their own assignment, once. The answer must match the
//   activity's type (and, for mcq / image_pick, be one of its options).
import type { Prisma } from '../../generated/prisma/client.js';
import { constraintViolation, Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { StudentScopeRepository } from '../users/student-scope.js';
import type { ActivitiesRepository, ActivityChanges, ActivityRecord, AssignmentRecord } from './activities.repository.js';
import {
  ActivityAnswerSchema,
  ActivityContentSchema,
  type ActivityAnswer,
  type ActivityContent,
  type ActivityDto,
  type CreateActivityBody,
  type CreateAssignmentBody,
  type CreateCompletionBody,
  type FamilyAssignmentDto,
  type ListActivitiesQuery,
  type ListAssignmentsQuery,
  type StaffAssignmentDto,
  type StudentAssignmentDto,
  type UpdateActivityBody,
} from './activities.schemas.js';

// ---------- Stored JSON ↔ API shapes ----------
/** The content column holds everything but `type` (a column of its own). */
function toStoredContent(content: ActivityContent): { type: ActivityContent['type']; content: Prisma.InputJsonObject } {
  const { type, ...rest } = content;
  return { type, content: rest as Prisma.InputJsonObject };
}

function contentOf(a: { type: string; content: Prisma.JsonValue }): ActivityContent {
  return ActivityContentSchema.parse({ ...(a.content as object), type: a.type });
}

/** What is frozen once assigned: the type and the options (order, ids, labels, images). */
function structureOf(content: ActivityContent): string {
  return JSON.stringify({ type: content.type, options: 'options' in content ? content.options : null });
}

function answerOf(response: Prisma.JsonValue): ActivityAnswer {
  return ActivityAnswerSchema.parse(response);
}

// ---------- Allow-list mappers ----------
function toActivityDto(a: ActivityRecord): ActivityDto {
  return {
    id: a.id,
    title: a.title,
    content: contentOf(a),
    isArchived: a.archivedAt !== null,
    isAssigned: a._count.assignments > 0,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function completionOf(a: AssignmentRecord) {
  return a.completion ? { answer: answerOf(a.completion.response), completedAt: a.completion.completedAt.toISOString() } : null;
}

export function toStaffAssignmentDto(a: AssignmentRecord): StaffAssignmentDto {
  return {
    id: a.id,
    studentId: a.studentId,
    activity: { id: a.activity.id, title: a.activity.title, type: a.activity.type },
    source: a.source,
    assignedBy: { id: a.assignedBy.id, fullName: a.assignedBy.fullName },
    observationId: a.observationId,
    assignedAt: a.createdAt.toISOString(),
    completion: completionOf(a),
  };
}

export function toStudentAssignmentDto(a: AssignmentRecord): StudentAssignmentDto {
  return {
    id: a.id,
    activity: { id: a.activity.id, title: a.activity.title, content: contentOf(a.activity) },
    assignedAt: a.createdAt.toISOString(),
    isDone: a.completion !== null,
    completion: completionOf(a),
  };
}

/** Parents: the activity and done / not done. Never the answer. */
export function toFamilyAssignmentDto(a: AssignmentRecord): FamilyAssignmentDto {
  return { id: a.id, title: a.activity.title, isDone: a.completion !== null };
}

export function createActivitiesService(deps: { repository: ActivitiesRepository; students: StudentScopeRepository }) {
  const { repository, students } = deps;

  function assertRole(actor: Actor, ...roles: Actor['role'][]): void {
    if (!roles.includes(actor.role)) throw Errors.forbidden();
  }

  // ---------- Library ----------
  async function createActivity(actor: Actor, body: CreateActivityBody): Promise<ActivityDto> {
    assertRole(actor, Role.Psychologist);
    const created = await repository.createActivity({ title: body.title.trim(), ...toStoredContent(body.content), createdById: actor.userId });
    return toActivityDto(created);
  }

  async function updateActivity(actor: Actor, id: string, body: UpdateActivityBody): Promise<ActivityDto> {
    assertRole(actor, Role.Psychologist);
    const updated = await repository.updateActivity(id, (current, isAssigned): ActivityChanges => {
      if (body.content && isAssigned && structureOf(body.content) !== structureOf(contentOf(current))) {
        throw Errors.conflict(
          "This activity has been assigned, so its type and options can't change. Archive it and create a new one.",
        );
      }
      return { title: body.title?.trim(), ...(body.content && toStoredContent(body.content)) };
    });
    if (!updated) throw Errors.notFound('Activity');
    return toActivityDto(updated);
  }

  async function archiveActivity(actor: Actor, id: string): Promise<ActivityDto> {
    assertRole(actor, Role.Psychologist);
    const archived = await repository.archiveActivity(id);
    if (!archived) throw Errors.notFound('Activity');
    return toActivityDto(archived);
  }

  async function listActivities(actor: Actor, query: ListActivitiesQuery): Promise<{ activities: ActivityDto[]; pagination: Pagination }> {
    assertRole(actor, Role.Psychologist, Role.Teacher);
    // Teachers browse what they can assign: active activities only.
    if (query.isArchived && actor.role !== Role.Psychologist) throw Errors.forbidden('Only psychologists can browse archived activities.');
    const { page, limit, sortBy, sortOrder, type, title } = query;
    const { items, total } = await repository.listActivities({
      skip: (page - 1) * limit,
      take: limit,
      sortBy,
      sortOrder,
      isArchived: query.isArchived ?? false,
      type,
      titleContains: title,
    });
    return { activities: items.map(toActivityDto), pagination: buildPagination(page, limit, total) };
  }

  async function getActivity(actor: Actor, id: string): Promise<ActivityDto> {
    assertRole(actor, Role.Psychologist, Role.Teacher);
    const found = await repository.findActivity(id);
    if (!found || (found.archivedAt !== null && actor.role !== Role.Psychologist)) throw Errors.notFound('Activity');
    return toActivityDto(found);
  }

  // ---------- Assignments ----------
  async function assignDirect(actor: Actor, body: CreateAssignmentBody): Promise<StaffAssignmentDto> {
    assertRole(actor, Role.Teacher);
    // Teachers reach only students of their own classes (same answer as an unknown student).
    const student = await students.findStudent(actor, body.studentId);
    if (!student) throw Errors.invalidReference('studentId', 'Student not found.');
    const created = await repository.createDirectAssignment({ activityId: body.activityId, studentId: student.id, assignedById: actor.userId });
    if (!created) throw Errors.invalidReference('activityId', 'Activity not found or archived.');
    return toStaffAssignmentDto(created);
  }

  async function listPage<T>(actor: Actor, studentId: string, query: ListAssignmentsQuery, map: (a: AssignmentRecord) => T) {
    const student = await students.findStudent(actor, studentId);
    if (!student) throw Errors.notFound('Student');
    const { page, limit, isDone } = query;
    const { items, total } = await repository.listAssignments(student.id, { skip: (page - 1) * limit, take: limit, isDone });
    return { assignments: items.map(map), pagination: buildPagination(page, limit, total) };
  }

  /** Teachers (own classes) and psychologists: a student's assignments, with answers. */
  async function listForStaff(actor: Actor, studentId: string, query: ListAssignmentsQuery) {
    assertRole(actor, Role.Teacher, Role.Psychologist);
    return listPage(actor, studentId, query, toStaffAssignmentDto);
  }

  /** The student's own assignments. */
  async function listMine(actor: Actor, query: ListAssignmentsQuery) {
    assertRole(actor, Role.Student);
    return listPage(actor, actor.userId, query, toStudentAssignmentDto);
  }

  /** A parent's child's assignments: done / not done only. */
  async function listForParent(actor: Actor, studentId: string, query: ListAssignmentsQuery) {
    assertRole(actor, Role.Parent);
    return listPage(actor, studentId, query, toFamilyAssignmentDto);
  }

  // ---------- Completions ----------
  async function complete(actor: Actor, body: CreateCompletionBody) {
    assertRole(actor, Role.Student);
    // Another student's assignment looks exactly like a missing one.
    const assignment = await repository.findStudentAssignment(body.assignmentId, actor.userId);
    if (!assignment) throw Errors.notFound('Assignment');
    if (assignment.completion) throw Errors.conflict('This activity has already been completed.');

    const content = contentOf(assignment.activity);
    const { answer } = body;
    if (answer.type !== content.type) {
      throw Errors.validation([{ field: 'answer.type', message: `must be "${content.type}" for this activity` }]);
    }
    if ('optionId' in answer && 'options' in content && !content.options.some((o) => o.id === answer.optionId)) {
      throw Errors.validation([{ field: 'answer.optionId', message: 'is not an option of this activity' }]);
    }

    let created;
    try {
      created = await repository.createCompletion(assignment.id, answer as Prisma.InputJsonObject);
    } catch (err) {
      // Lost a race with a concurrent submission of the same assignment.
      if (constraintViolation(err)?.kind === 'unique') throw Errors.conflict('This activity has already been completed.');
      throw err;
    }
    return {
      id: created.id,
      assignmentId: created.assignmentId,
      answer: answerOf(created.response),
      completedAt: created.completedAt.toISOString(),
    };
  }

  return {
    createActivity,
    updateActivity,
    archiveActivity,
    listActivities,
    getActivity,
    assignDirect,
    listForStaff,
    listMine,
    listForParent,
    complete,
  };
}

export type ActivitiesService = ReturnType<typeof createActivitiesService>;
