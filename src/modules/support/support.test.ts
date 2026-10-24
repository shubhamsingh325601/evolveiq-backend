import { describe, expect, test } from 'vitest';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { PlanChanges, SupportPlanRecord, SupportRepository } from './support.repository.js';
import { createSupportService } from './support.service.js';

const NOW = new Date('2026-10-24T06:00:00.000Z');
const teacher: Actor = { userId: 't1', role: Role.Teacher, schoolId: 's1' };
const outsider: Actor = { userId: 't2', role: Role.Teacher, schoolId: 's1' };

function setup() {
  const plans = new Map<string, SupportPlanRecord>();
  let counter = 0;
  const repository: SupportRepository = {
    create: async (data) => {
      const plan: SupportPlanRecord = {
        id: `p${++counter}`,
        studentId: data.studentId,
        category: data.category,
        summary: data.summary,
        strategies: data.strategies,
        status: 'active',
        reviewOn: data.reviewOn,
        closedAt: null,
        createdAt: new Date(NOW.getTime() + counter),
        createdBy: { fullName: 'Teacher One' },
      };
      plans.set(plan.id, plan);
      return plan;
    },
    forStudent: async (studentId) => [...plans.values()].filter((p) => p.studentId === studentId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    find: async (id) => plans.get(id) ?? null,
    update: async (id, changes: PlanChanges) => {
      const current = plans.get(id)!;
      const next: SupportPlanRecord = {
        ...current,
        ...(changes.summary !== undefined && { summary: changes.summary }),
        ...(changes.strategies !== undefined && { strategies: changes.strategies }),
        ...(changes.status !== undefined && { status: changes.status }),
        ...(changes.reviewOn !== undefined && { reviewOn: changes.reviewOn }),
        ...(changes.closedAt !== undefined && { closedAt: changes.closedAt }),
      };
      plans.set(id, next);
      return next;
    },
  };
  const students = { findStudent: async (actor: Actor) => (actor.userId === 't2' ? null : { id: 'c1', fullName: 'Child', schoolId: 's1', createdAt: NOW }) };
  return createSupportService({ repository, students, now: () => NOW });
}

describe('support plans', () => {
  test('a teacher opens a plan with labels and a trimmed summary', async () => {
    const plan = await setup().create(teacher, 'c1', { category: 'sensory', summary: '  Loud rooms are hard.  ', strategies: 'A quiet corner.' });
    expect(plan).toMatchObject({ categoryLabel: 'Sensory needs', summary: 'Loud rooms are hard.', status: 'active', statusLabel: 'In place', isReviewDue: false });
  });

  test('a student outside the teacher’s scope is a 404, for create, list and update', async () => {
    const service = setup();
    const plan = await service.create(teacher, 'c1', { category: 'learning', summary: 'Needs extra time.' });
    await expect(service.create(outsider, 'c1', { category: 'learning', summary: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.list(outsider, 'c1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.update(outsider, plan.id, { summary: 'changed' })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('closing stamps the time, reopening clears it, and closed plans list last', async () => {
    const service = setup();
    const first = await service.create(teacher, 'c1', { category: 'learning', summary: 'First.' });
    await service.create(teacher, 'c1', { category: 'attention', summary: 'Second.' });
    const closed = await service.update(teacher, first.id, { status: 'closed' });
    expect(closed.closedAt).toBe(NOW.toISOString());
    expect((await service.list(teacher, 'c1')).map((p) => p.summary)).toEqual(['Second.', 'First.']);
    const reopened = await service.update(teacher, first.id, { status: 'in_review' });
    expect(reopened).toMatchObject({ status: 'in_review', closedAt: null });
  });

  test('a review date that has arrived flags the plan, until it is closed', async () => {
    const service = setup();
    const plan = await service.create(teacher, 'c1', { category: 'emotional', summary: 'Settling in.', reviewOn: '2026-10-24' });
    expect(plan.isReviewDue).toBe(true);
    expect((await service.update(teacher, plan.id, { status: 'closed' })).isReviewDue).toBe(false);
  });

  test('strategies and the review date can be cleared', async () => {
    const service = setup();
    const plan = await service.create(teacher, 'c1', { category: 'gifted', summary: 'Ready for more.', strategies: 'Extension tasks.', reviewOn: '2026-12-01' });
    const cleared = await service.update(teacher, plan.id, { strategies: null, reviewOn: null });
    expect(cleared).toMatchObject({ strategies: null, reviewOn: null });
  });

  test('an unknown plan is a 404', async () => {
    await expect(setup().update(teacher, 'nope', { summary: 'x' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
