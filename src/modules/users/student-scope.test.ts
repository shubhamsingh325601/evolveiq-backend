// The row-level student scope per role. Integration tests exercise it through every
// student-facing endpoint; this pins the rule table itself.
import { describe, expect, test } from 'vitest';
import type { Actor } from '../../shared/rbac/index.js';
import { studentScope } from './student-scope.js';

const ME = '11111111-1111-4111-8111-111111111111';
const SCHOOL = '22222222-2222-4222-8222-222222222222';
const actor = (role: Actor['role'], schoolId: string | null = SCHOOL): Actor => ({ userId: ME, role, schoolId });

describe('studentScope', () => {
  test('student: only themselves', () => {
    expect(studentScope(actor('student'))).toEqual({ role: 'student', id: ME });
  });

  test('parent: only children linked to them', () => {
    expect(studentScope(actor('parent'))).toEqual({ role: 'student', parentLink: { parentId: ME } });
  });

  test('teacher: only students of classes they are assigned to', () => {
    expect(studentScope(actor('teacher'))).toEqual({
      role: 'student',
      classLink: { class: { teachers: { some: { teacherId: ME } } } },
    });
  });

  test('school admin: students of their own school; no school → nothing', () => {
    expect(studentScope(actor('school_admin'))).toEqual({ role: 'student', schoolId: SCHOOL });
    expect(studentScope(actor('school_admin', null))).toEqual({ id: { in: [] } });
  });

  test.each(['psychologist', 'platform_admin'] as const)('%s: every student (cross-school)', (role) => {
    expect(studentScope(actor(role, null))).toEqual({ role: 'student' });
  });
});
