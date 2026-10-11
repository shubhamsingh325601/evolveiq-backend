// The per-audience allow-list mappers, tested on their own (the route response schemas are a
// second, independent layer). Given a FULLY populated, reviewed record — every clinical field
// set — each mapper must return exactly its allowed keys and none of the clinical values.
import { describe, expect, test } from 'vitest';
import type { ObservationRecord } from './observations.repository.js';
import { toParentDto, toReviewDto, toTeacherDto } from './observations.service.js';

const reviewed: ObservationRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  schoolId: '22222222-2222-4222-8222-222222222222',
  studentId: '33333333-3333-4333-8333-333333333333',
  authorId: '44444444-4444-4444-8444-444444444444',
  authorRole: 'teacher',
  area: 'behaviour',
  description: 'Pushed a classmate.',
  observedWhen: 'today',
  frequency: 'sometimes',
  level: 'significant',
  learningBehaviourArea: 'self_control',
  status: 'reviewed',
  reviewOutcome: 'assigned',
  developmentArea: 'self_control',
  teacherOnlyNote: 'CLINICAL-NOTE',
  reviewedAt: new Date('2026-10-02T10:00:00.000Z'),
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  student: { id: '33333333-3333-4333-8333-333333333333', fullName: 'Kid' },
  author: { id: '44444444-4444-4444-8444-444444444444', fullName: 'Teacher' },
  reviewedBy: { id: '55555555-5555-4555-8555-555555555555', fullName: 'REVIEWER-NAME' },
  assignments: [{ activityId: '66666666-6666-4666-8666-666666666666' }],
};

describe('toParentDto — parent allow-list', () => {
  test('exactly the parent fields; nothing clinical, even when the record has it all', () => {
    const dto = toParentDto({ ...reviewed, authorRole: 'parent' });
    expect(dto).toEqual({
      id: reviewed.id,
      studentId: reviewed.studentId,
      area: 'behaviour',
      description: 'Pushed a classmate.',
      when: 'today',
      howOften: 'sometimes',
      status: 'reviewed',
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    const raw = JSON.stringify(dto);
    for (const secret of ['significant', 'self_control', 'CLINICAL-NOTE', 'REVIEWER-NAME', '5555', '6666', 'assigned']) {
      expect(raw, secret).not.toContain(secret);
    }
  });
});

describe('toTeacherDto — teacher allow-list', () => {
  test('their observation, status, review date and the teacher-only note; no reviewer, development area or assignments', () => {
    const dto = toTeacherDto(reviewed);
    expect(Object.keys(dto).sort()).toEqual(
      ['area', 'createdAt', 'description', 'howOften', 'id', 'learningBehaviourArea', 'level', 'reviewedAt', 'status', 'studentId', 'teacherOnlyNote', 'when'],
    );
    expect(dto).toMatchObject({
      level: 'significant',
      learningBehaviourArea: 'self_control',
      teacherOnlyNote: 'CLINICAL-NOTE',
      reviewedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(toTeacherDto({ ...reviewed, status: 'pending', reviewOutcome: null, developmentArea: null, teacherOnlyNote: null, reviewedAt: null, reviewedBy: null, assignments: [] }).reviewedAt).toBeNull();
    const raw = JSON.stringify(dto);
    for (const secret of ['REVIEWER-NAME', '5555', '6666', 'developmentArea', 'assigned']) expect(raw, secret).not.toContain(secret);
  });
});

describe('toReviewDto — psychologist view', () => {
  test('includes the review once reviewed', () => {
    expect(toReviewDto(reviewed).review).toEqual({
      outcome: 'assigned',
      developmentArea: 'self_control',
      teacherOnlyNote: 'CLINICAL-NOTE',
      reviewedBy: { id: '55555555-5555-4555-8555-555555555555', fullName: 'REVIEWER-NAME' },
      reviewedAt: '2026-10-02T10:00:00.000Z',
      activityIds: ['66666666-6666-4666-8666-666666666666'],
    });
  });

  test('review is null while pending', () => {
    const pending: ObservationRecord = {
      ...reviewed,
      status: 'pending',
      reviewOutcome: null,
      developmentArea: null,
      teacherOnlyNote: null,
      reviewedAt: null,
      reviewedBy: null,
      assignments: [],
    };
    expect(toReviewDto(pending).review).toBeNull();
  });
});
