// Business rules for school support plans. No HTTP, no SQL.
//
// Who: teachers (for students of their classes) and psychologists (any student), through the
//   shared student scope. Parents and students never reach this module (the routes admit only
//   staff), and a plan never feeds the Holistic Index or any parent-facing response.
// A plan has a category, a plain summary and optional classroom strategies. Status moves
//   in place -> being reviewed -> closed; closing stamps the time and reopening clears it.
//   Plans are closed, never deleted, so the history stays.
import { Errors } from '../../shared/errors/index.js';
import type { Actor } from '../../shared/rbac/index.js';
import { businessDate } from '../progress/business-time.js';
import type { StudentScopeRepository } from '../users/student-scope.js';
import type { PlanChanges, SupportPlanRecord, SupportRepository } from './support.repository.js';
import {
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_STATUS_LABELS,
  type CreatePlanBody,
  type SupportPlanDto,
  type UpdatePlanBody,
} from './support.schemas.js';

const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

export function toPlanDto(plan: SupportPlanRecord, today: string): SupportPlanDto {
  const reviewOn = plan.reviewOn?.toISOString().slice(0, 10) ?? null;
  return {
    id: plan.id,
    studentId: plan.studentId,
    category: plan.category,
    categoryLabel: SUPPORT_CATEGORY_LABELS[plan.category],
    summary: plan.summary,
    strategies: plan.strategies,
    status: plan.status,
    statusLabel: SUPPORT_STATUS_LABELS[plan.status],
    reviewOn,
    isReviewDue: plan.status !== 'closed' && reviewOn !== null && reviewOn <= today,
    createdBy: { fullName: plan.createdBy.fullName },
    createdAt: plan.createdAt.toISOString(),
    closedAt: plan.closedAt?.toISOString() ?? null,
  };
}

export function createSupportService(deps: { repository: SupportRepository; students: StudentScopeRepository; now: () => Date }) {
  const { repository, students, now } = deps;

  async function requireStudent(actor: Actor, studentId: string): Promise<void> {
    if (!(await students.findStudent(actor, studentId))) throw Errors.notFound('Student');
  }

  async function create(actor: Actor, studentId: string, body: CreatePlanBody): Promise<SupportPlanDto> {
    await requireStudent(actor, studentId);
    const plan = await repository.create({
      studentId,
      createdById: actor.userId,
      category: body.category,
      summary: body.summary.trim(),
      strategies: body.strategies?.trim() ?? null,
      reviewOn: body.reviewOn ? asDate(body.reviewOn) : null,
    });
    return toPlanDto(plan, businessDate(now()));
  }

  async function list(actor: Actor, studentId: string): Promise<SupportPlanDto[]> {
    await requireStudent(actor, studentId);
    const today = businessDate(now());
    const plans = (await repository.forStudent(studentId)).map((plan) => toPlanDto(plan, today));
    // Open plans first; each group keeps its newest-first order.
    return [...plans.filter((p) => p.status !== 'closed'), ...plans.filter((p) => p.status === 'closed')];
  }

  async function update(actor: Actor, planId: string, body: UpdatePlanBody): Promise<SupportPlanDto> {
    const current = await repository.find(planId);
    // A plan for a student outside the caller's scope is reported as missing.
    if (!current) throw Errors.notFound('Support plan');
    await requireStudent(actor, current.studentId).catch(() => {
      throw Errors.notFound('Support plan');
    });

    const changes: PlanChanges = {
      summary: body.summary?.trim(),
      strategies: body.strategies === undefined ? undefined : (body.strategies?.trim() ?? null),
      status: body.status,
      reviewOn: body.reviewOn === undefined ? undefined : body.reviewOn === null ? null : asDate(body.reviewOn),
      closedAt: body.status === undefined ? undefined : body.status === 'closed' ? (current.closedAt ?? now()) : null,
    };
    const updated = await repository.update(planId, changes);
    return toPlanDto(updated, businessDate(now()));
  }

  return { create, list, update };
}

export type SupportService = ReturnType<typeof createSupportService>;
