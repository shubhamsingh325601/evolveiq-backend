// Fixtures for workflow tests: a school with a School Admin, a teacher with a class, a student in
// that class and the student's linked parent — all created through the real API, so every
// fixture also exercises the endpoints that build it.
import type { TestContext } from './api-harness.js';
import { createAndLogin } from './api-harness.js';

export interface Account {
  id: string;
  token: string;
  refreshToken: string;
}

export interface SchoolFixture {
  schoolId: string;
  schoolAdmin: Account;
  teacher: Account;
  classId: string;
  student: Account;
  parent: Account;
}

const PW = 'Fixture-Password-1';
let seq = 0;

async function expectStatus(promise: Promise<{ status: number; body: unknown }>, status: number, what: string) {
  const r = await promise;
  if (r.status !== status) throw new Error(`${what} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

/** A fresh account of `role` in `schoolId` (none for psychologist / platform_admin). */
export async function newAccount(ctx: TestContext, rootToken: string, role: string, schoolId?: string): Promise<Account> {
  seq += 1;
  const tag = `${process.pid}-${seq}`;
  if (role === 'student') {
    return createAndLogin(ctx, rootToken, { role, fullName: `Student ${seq}`, studentId: `FX-${tag}`, pin: '482913', schoolId });
  }
  return createAndLogin(ctx, rootToken, {
    role,
    fullName: `${role} ${seq}`,
    email: `fx${tag}@fixtures.test`,
    password: PW,
    ...(schoolId && { schoolId }),
  });
}

/** Adds `student` to a new or existing class of the fixture's school. */
export async function addStudentToClass(ctx: TestContext, f: SchoolFixture, studentId: string, classId = f.classId) {
  await expectStatus(ctx.put(`/api/v1/classes/${classId}/students/${studentId}`, f.schoolAdmin.token), 204, 'add student to class');
}

/** A complete school: admin, teacher → class ← student, parent ↔ student. */
export async function createSchoolFixture(ctx: TestContext, rootToken: string, schoolId: string): Promise<SchoolFixture> {
  const schoolAdmin = await newAccount(ctx, rootToken, 'school_admin', schoolId);
  const teacher = await newAccount(ctx, rootToken, 'teacher', schoolId);
  const student = await newAccount(ctx, rootToken, 'student', schoolId);
  const parent = await newAccount(ctx, rootToken, 'parent', schoolId);
  seq += 1;
  const created = await expectStatus(ctx.post('/api/v1/classes', { name: `Fixture Class ${process.pid}-${seq}` }, schoolAdmin.token), 201, 'create class');
  const classId = (created.body as { class: { id: string } }).class.id;
  await expectStatus(ctx.put(`/api/v1/classes/${classId}/teachers/${teacher.id}`, schoolAdmin.token), 204, 'assign teacher');
  await expectStatus(ctx.put(`/api/v1/classes/${classId}/students/${student.id}`, schoolAdmin.token), 204, 'add student');
  await expectStatus(ctx.post('/api/v1/parent-students', { parentId: parent.id, studentId: student.id }, schoolAdmin.token), 201, 'link parent');
  return { schoolId, schoolAdmin, teacher, classId, student, parent };
}

/** A psychologist-authored activity of the given content; returns its id. */
export async function createActivity(ctx: TestContext, psychologistToken: string, content: Record<string, unknown>, title = 'Fixture activity'): Promise<string> {
  const r = await expectStatus(ctx.post('/api/v1/activities', { title, content }, psychologistToken), 201, 'create activity');
  return (r.body as { activity: { id: string } }).activity.id;
}

export const MCQ = { type: 'mcq', prompt: 'How do you feel?', options: [{ id: 'happy', label: 'Happy' }, { id: 'sad', label: 'Sad' }] };
export const TEXT = { type: 'text', prompt: 'Tell us about your day.' };
export const IMAGE_PICK = {
  type: 'image_pick',
  prompt: 'Pick the calm picture.',
  options: [
    { id: 'lake', imageUrl: 'https://cdn.example.test/lake.png', label: 'Lake' },
    { id: 'storm', imageUrl: 'https://cdn.example.test/storm.png' },
  ],
};
export const RATING = { type: 'rating', prompt: 'How well did you sleep?' };
export const MEDIA = { type: 'media_response', prompt: 'Watch, then tell us one thing you noticed.', mediaUrl: 'https://cdn.example.test/clip.mp4' };
