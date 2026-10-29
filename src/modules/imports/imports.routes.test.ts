// Importing people from a spreadsheet — Supertest over HTTP against the real app + PostgreSQL.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { createSchoolFixture, type SchoolFixture } from '../../../test/support/fixtures.js';

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let className: string;
let parentEmail: string;
let studentLoginId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  className = (await ctx.get(`/api/v1/classes/${a.classId}`, a.schoolAdmin.token)).body.class.name;
  parentEmail = (await ctx.get(`/api/v1/users/${a.parent.id}`, a.schoolAdmin.token)).body.user.email;
  studentLoginId = (await ctx.get(`/api/v1/users/${a.student.id}`, a.schoolAdmin.token)).body.user.studentId;
});

afterAll(async () => {
  await ctx?.close();
});

const IMPORT = '/api/v1/imports/people';
const send = (body: unknown, token = a.schoolAdmin.token) => ctx.post(IMPORT, body, token);
const userCount = async () => Number((await ctx.pg.query('SELECT count(*) FROM users')).rows[0].count);

describe('students', () => {
  const asha = () => ({ fullName: 'Asha Rao', studentId: 'imp-001', pin: '123456', className: className.toUpperCase(), parentEmail: parentEmail.toUpperCase() });
  const ben = { fullName: 'Ben Thomas', studentId: 'IMP-002', pin: '654321', className: 'Import 9Z' };

  test('a dry run checks every row and creates nothing', async () => {
    const before = await userCount();
    const r = await send({
      role: 'student',
      rows: [
        asha(),
        { fullName: 'No Pin', studentId: 'IMP-003', pin: '12' },
        { fullName: 'Twice', studentId: 'imp-001', pin: '123456' },
        { fullName: 'Taken', studentId: studentLoginId, pin: '123456' },
        { fullName: '', studentId: 'x', pin: '123456', parentEmail: 'nobody@nowhere.test' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.report).toMatchObject({ role: 'student', dryRun: true, isValid: false, created: 0 });
    const problems = r.body.report.rows.map((row: { problems: string[] }) => row.problems);
    expect(problems[0]).toEqual([]);
    expect(problems[1]).toEqual(['PIN must be exactly 6 digits']);
    expect(problems[2]).toEqual(['This student ID is in the file twice']);
    expect(problems[3]).toEqual(['This student ID is already in use']);
    expect(problems[4]).toEqual(
      expect.arrayContaining(['Full name is missing', 'Student ID must be 3–32 letters, digits or hyphens', expect.stringContaining('No parent with the email')]),
    );
    expect(r.body.report.rows[0]).toMatchObject({ row: 1, fullName: 'Asha Rao', identifier: 'IMP-001' });
    expect(await userCount()).toBe(before);
  });

  test('one bad row stops the whole import, even when it is not a dry run', async () => {
    const before = await userCount();
    const r = await send({ role: 'student', dryRun: false, rows: [asha(), { fullName: 'No Pin', studentId: 'IMP-003', pin: '' }] });
    expect(r.body.report).toMatchObject({ isValid: false, created: 0 });
    expect(await userCount()).toBe(before);
  });

  test('creates the students, their new class, their class places and parent links', async () => {
    const preview = await send({ role: 'student', rows: [asha(), ben] });
    expect(preview.body.report).toMatchObject({ isValid: true, created: 0, newClasses: ['Import 9Z'] });

    const r = await send({ role: 'student', dryRun: false, rows: [asha(), ben] });
    expect(r.status).toBe(200);
    expect(r.body.report).toMatchObject({ isValid: true, created: 2, newClasses: ['Import 9Z'] });

    expect((await ctx.login({ studentId: 'IMP-001', pin: '123456' })).status).toBe(200);
    const existing = await ctx.get(`/api/v1/classes/${a.classId}`, a.schoolAdmin.token);
    expect(existing.body.students.map((s: { fullName: string }) => s.fullName)).toContain('Asha Rao');
    const classes = (await ctx.get('/api/v1/classes?limit=100', a.schoolAdmin.token)).body.classes as { name: string }[];
    expect(classes.map((c) => c.name)).toContain('Import 9Z');
    const links = (await ctx.get('/api/v1/parent-students', a.parent.token)).body.links as { student: { fullName: string } }[];
    expect(links.map((l) => l.student.fullName)).toContain('Asha Rao');
  });
});

describe('teachers and parents', () => {
  test('teachers are created with their classes', async () => {
    const r = await send({
      role: 'teacher',
      dryRun: false,
      rows: [{ fullName: 'Imran Ali', email: 'Imran@Import.test', password: 'Import-Password-1', classNames: [className, 'Import 9Z', 'Import 10A'] }],
    });
    expect(r.body.report).toMatchObject({ isValid: true, created: 1, newClasses: ['Import 10A'] });
    const login = await ctx.login({ email: 'imran@import.test', password: 'Import-Password-1' });
    expect(login.status).toBe(200);
    const mine = (await ctx.get('/api/v1/classes', login.body.accessToken)).body.classes as { name: string }[];
    expect(mine.map((c) => c.name).sort()).toEqual([className, 'Import 10A', 'Import 9Z'].sort());
  });

  test('parents are linked to their children, who must be free', async () => {
    const report = await send({
      role: 'parent',
      rows: [
        { fullName: 'Taken Child', email: 'p1@import.test', password: 'Import-Password-1', childStudentIds: [studentLoginId] },
        { fullName: 'Unknown Child', email: 'p2@import.test', password: 'Import-Password-1', childStudentIds: ['NOPE-1'] },
        { fullName: 'Short', email: 'p3@import.test', password: 'short' },
        { fullName: 'Same Email', email: 'P3@import.test', password: 'Import-Password-1' },
      ],
    });
    const problems = report.body.report.rows.map((row: { problems: string[] }) => row.problems);
    expect(problems[0]).toEqual([`${studentLoginId} already has a parent linked`]);
    expect(problems[1]).toEqual(['No student with the ID NOPE-1 at this school']);
    expect(problems[2]).toEqual(['Password must be 10–128 characters']);
    expect(problems[3]).toEqual(['This email address is in the file twice']);

    const r = await send({ role: 'parent', dryRun: false, rows: [{ fullName: 'Mira Thomas', email: 'mira@import.test', password: 'Import-Password-1', childStudentIds: ['imp-002'] }] });
    expect(r.body.report).toMatchObject({ isValid: true, created: 1, newClasses: [] });
    const login = await ctx.login({ email: 'mira@import.test', password: 'Import-Password-1' });
    const links = (await ctx.get('/api/v1/parent-students', login.body.accessToken)).body.links as { student: { fullName: string } }[];
    expect(links.map((l) => l.student.fullName)).toEqual(['Ben Thomas']);
  });

  test('an email already in use is reported against its row', async () => {
    const r = await send({ role: 'teacher', rows: [{ fullName: 'Again', email: 'imran@import.test', password: 'Import-Password-1' }] });
    expect(r.body.report.rows[0].problems).toEqual(['This email address is already in use']);
  });
});

describe('who imports where', () => {
  const row = { fullName: 'X', studentId: 'IMP-900', pin: '123456' };

  test('a school admin only into their own school', async () => {
    expect((await send({ role: 'student', schoolId: SCHOOL_B, rows: [row] })).status).toBe(403);
    expect((await send({ role: 'student', rows: [row] }, a.teacher.token)).status).toBe(403);
    expect((await send({ role: 'student', rows: [row] }, a.parent.token)).status).toBe(403);
  });

  test('a platform admin names the school, which must exist', async () => {
    expect((await send({ role: 'student', rows: [row] }, rootToken)).status).toBe(400);
    expect((await send({ role: 'student', schoolId: '99999999-9999-4999-8999-999999999999', rows: [row] }, rootToken)).status).toBe(422);
    const r = await send({ role: 'student', schoolId: SCHOOL_B, dryRun: false, rows: [row] }, rootToken);
    expect(r.body.report).toMatchObject({ isValid: true, created: 1 });
    const placed = await ctx.get('/api/v1/users?role=student&name=X', b.schoolAdmin.token);
    expect(placed.body.users.map((u: { studentId: string }) => u.studentId)).toContain('IMP-900');
  });

  test('takes 1 to 500 rows of known columns', async () => {
    expect((await send({ role: 'student', rows: [] })).status).toBe(400);
    expect((await send({ role: 'student', rows: Array.from({ length: 501 }, () => row) })).status).toBe(400);
    expect((await send({ role: 'student', rows: [{ ...row, email: 'x@y.test' }] })).status).toBe(400);
    expect((await send({ role: 'psychologist', rows: [row] })).status).toBe(400);
  });
});
