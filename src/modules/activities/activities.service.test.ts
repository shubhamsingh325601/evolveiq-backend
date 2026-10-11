// The assignment allow-list mappers, tested on their own (the route response schemas are a
// second, independent layer). A completed assignment with an answer goes in; each audience
// gets exactly its fields.
import { describe, expect, test } from 'vitest';
import type { AssignmentRecord } from './activities.repository.js';
import { toFamilyAssignmentDto, toStaffAssignmentDto, toStudentAssignmentDto } from './activities.service.js';

const completed: AssignmentRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  studentId: '22222222-2222-4222-8222-222222222222',
  source: 'recommended',
  observationId: '33333333-3333-4333-8333-333333333333',
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  activity: { id: '44444444-4444-4444-8444-444444444444', title: 'Journal', type: 'text', content: { prompt: 'How was school?' } },
  assignedBy: { id: '55555555-5555-4555-8555-555555555555', fullName: 'Dr PSYCH-NAME' },
  completion: { id: '66666666-6666-4666-8666-666666666666', response: { type: 'text', text: 'SECRET-ANSWER' }, completedAt: new Date('2026-10-02T10:00:00.000Z') },
};

describe('toFamilyAssignmentDto — parent allow-list', () => {
  test('title, done / not done and when — never the answer, source, assigner or observation', () => {
    expect(toFamilyAssignmentDto(completed)).toEqual({
      id: completed.id,
      title: 'Journal',
      isDone: true,
      assignedAt: '2026-10-01T10:00:00.000Z',
      completedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(toFamilyAssignmentDto({ ...completed, completion: null })).toEqual({
      id: completed.id,
      title: 'Journal',
      isDone: false,
      assignedAt: '2026-10-01T10:00:00.000Z',
      completedAt: null,
    });
    const raw = JSON.stringify(toFamilyAssignmentDto(completed));
    for (const secret of ['SECRET-ANSWER', 'PSYCH-NAME', '3333', 'recommended']) expect(raw, secret).not.toContain(secret);
  });
});

describe('toStudentAssignmentDto — the student\'s own view', () => {
  test('the activity to do and their own answer; no assigner, source or observation', () => {
    const dto = toStudentAssignmentDto(completed);
    expect(Object.keys(dto).sort()).toEqual(['activity', 'assignedAt', 'completion', 'id', 'isDone']);
    expect(dto.activity.content).toEqual({ type: 'text', prompt: 'How was school?' });
    expect(dto.completion).toEqual({ answer: { type: 'text', text: 'SECRET-ANSWER' }, completedAt: '2026-10-02T10:00:00.000Z' });
    const raw = JSON.stringify(dto);
    for (const secret of ['PSYCH-NAME', '3333', 'recommended']) expect(raw, secret).not.toContain(secret);
  });
});

describe('toStaffAssignmentDto — teacher / psychologist view', () => {
  test('includes source, assigner, observation and the answer', () => {
    expect(toStaffAssignmentDto(completed)).toMatchObject({
      source: 'recommended',
      assignedBy: { fullName: 'Dr PSYCH-NAME' },
      observationId: completed.observationId,
      completion: { answer: { type: 'text', text: 'SECRET-ANSWER' } },
    });
  });
});
