// The Staff Training & Development Hub — Supertest over HTTP against the real app + PostgreSQL.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { createSchoolFixture, newAccount, type Account, type SchoolFixture } from '../../../test/support/fixtures.js';

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let psych: Account;

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  psych = await newAccount(ctx, rootToken, 'psychologist');
});

afterAll(async () => {
  await ctx?.close();
});

const TRAININGS = '/api/v1/trainings';
const post = (body: unknown, token: string) => ctx.post(TRAININGS, body, token);
const titles = async (token: string, query = '') =>
  ((await ctx.get(`${TRAININGS}${query}`, token)).body.trainings as { title: string }[]).map((t) => t.title);

describe('posting and reading', () => {
  test('a school admin posts for their school, and a teacher sees it plus every-school trainings', async () => {
    const training = await post(
      { title: 'Fire safety drill', requirement: 'mandatory', credits: 2, scheduledOn: '2026-11-20' },
      a.schoolAdmin.token,
    );
    expect(training.status).toBe(201);
    expect(training.body.training).toMatchObject({
      schoolId: SCHOOL_A,
      title: 'Fire safety drill',
      requirement: 'mandatory',
      credits: 2,
      scheduledOn: '2026-11-20',
      canManage: true,
      myEnrolment: null,
    });

    expect(await titles(a.teacher.token)).toContain('Fire safety drill');
    expect(await titles(b.teacher.token)).not.toContain('Fire safety drill');
    expect(await titles(a.schoolAdmin.token)).toContain('Fire safety drill');

    const asTeacher = (await ctx.get(TRAININGS, a.teacher.token)).body.trainings[0];
    expect(asTeacher.canManage).toBe(false);
  });

  test('a platform admin posts for every school, and one for a single school', async () => {
    const everySchool = await post({ title: 'Child safeguarding refresher', requirement: 'mandatory', credits: 1 }, rootToken);
    expect(everySchool.status).toBe(201);
    expect(everySchool.body.training).toMatchObject({ schoolId: null, schoolName: null, canManage: true });
    expect(await titles(a.teacher.token)).toContain('Child safeguarding refresher');
    expect(await titles(b.teacher.token)).toContain('Child safeguarding refresher');
    expect(await titles(psych.token)).toContain('Child safeguarding refresher');

    const oneSchool = await post({ title: 'Halden induction', requirement: 'optional', credits: 0, schoolId: SCHOOL_B }, rootToken);
    expect(oneSchool.status).toBe(201);
    expect(await titles(b.teacher.token)).toContain('Halden induction');
    expect(await titles(a.teacher.token)).not.toContain('Halden induction');

    const unknown = await post(
      { title: 'Nowhere', requirement: 'optional', credits: 0, schoolId: '99999999-9999-4999-8999-999999999999' },
      rootToken,
    );
    expect(unknown.status).toBe(422);

    const seenByAdmin = (
      (await ctx.get(TRAININGS, a.schoolAdmin.token)).body.trainings as { title: string; canManage: boolean }[]
    ).find((t) => t.title === 'Child safeguarding refresher');
    expect(seenByAdmin?.canManage).toBe(false);
  });
});

describe('rules', () => {
  test('only admins post, and a school admin only for their own school', async () => {
    expect((await post({ title: 'x', requirement: 'optional', credits: 0 }, a.teacher.token)).status).toBe(403);
    expect((await post({ title: 'x', requirement: 'optional', credits: 0 }, a.parent.token)).status).toBe(403);
    expect((await post({ title: 'x', requirement: 'optional', credits: 0, schoolId: SCHOOL_B }, a.schoolAdmin.token)).status).toBe(403);
    expect((await post({ title: '   ', requirement: 'optional', credits: 0 }, a.schoolAdmin.token)).status).toBe(400);
    expect((await post({ title: 'x', requirement: 'optional', credits: 25 }, a.schoolAdmin.token)).status).toBe(400);
    expect((await post({ title: 'x', requirement: 'urgent', credits: 0 }, a.schoolAdmin.token)).status).toBe(400);
  });

  test('only platform admins filter the list by school', async () => {
    expect((await ctx.get(`${TRAININGS}?schoolId=${SCHOOL_A}`, a.schoolAdmin.token)).status).toBe(403);
    expect((await ctx.get(`${TRAININGS}?schoolId=${SCHOOL_A}`, psych.token)).status).toBe(403);
    const onlyA = (await ctx.get(`${TRAININGS}?schoolId=${SCHOOL_A}`, rootToken)).body.trainings as { schoolId: string }[];
    expect(onlyA.every((t) => t.schoolId === SCHOOL_A)).toBe(true);
  });

  test('a training is edited and taken down by whoever may manage it; cross-school is 404', async () => {
    const created = (await post({ title: 'Classroom first aid', requirement: 'recommended', credits: 3 }, a.schoolAdmin.token)).body
      .training;
    const path = `${TRAININGS}/${created.id}`;
    expect((await ctx.patch(path, { credits: 4 }, b.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.del(path, b.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.patch(path, { credits: 4 }, a.teacher.token)).status).toBe(403);
    expect((await ctx.del(path, a.teacher.token)).status).toBe(403);

    const edited = await ctx.patch(path, { credits: 4, description: 'Bring your own gloves.' }, a.schoolAdmin.token);
    expect(edited.status).toBe(200);
    expect(edited.body.training).toMatchObject({ credits: 4, description: 'Bring your own gloves.' });
    expect((await ctx.patch(path, {}, a.schoolAdmin.token)).status).toBe(400);

    expect((await ctx.del(path, a.schoolAdmin.token)).status).toBe(204);
    expect((await ctx.del(path, a.schoolAdmin.token)).status).toBe(404);
  });
});

describe('enrolment', () => {
  test('a teacher enrols, cannot enrol twice, and marks it complete', async () => {
    const created = (await post({ title: 'Classroom management', requirement: 'recommended', credits: 2 }, a.schoolAdmin.token)).body
      .training;
    const path = `${TRAININGS}/${created.id}/enrolment`;

    const enrolled = await ctx.post(path, {}, a.teacher.token);
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.enrolment).toEqual({ isComplete: false });

    const again = await ctx.post(path, {}, a.teacher.token);
    expect(again.status).toBe(409);

    const listed = (await ctx.get(TRAININGS, a.teacher.token)).body.trainings as { id: string; myEnrolment: { isComplete: boolean } | null }[];
    expect(listed.find((t) => t.id === created.id)?.myEnrolment).toEqual({ isComplete: false });

    const completed = await ctx.patch(path, {}, a.teacher.token);
    expect(completed.status).toBe(200);
    expect(completed.body.enrolment).toEqual({ isComplete: true });

    const listedAgain = (await ctx.get(TRAININGS, a.teacher.token)).body.trainings as { id: string; myEnrolment: { isComplete: boolean } | null }[];
    expect(listedAgain.find((t) => t.id === created.id)?.myEnrolment).toEqual({ isComplete: true });

    // Another teacher never enrolled: their own list shows no enrolment on the same training, and
    // completing one they never joined is a 404 (their own enrolment only).
    const otherTeacher = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
    const otherListed = (await ctx.get(TRAININGS, otherTeacher.token)).body.trainings as { id: string; myEnrolment: unknown }[];
    expect(otherListed.find((t) => t.id === created.id)?.myEnrolment).toBeNull();
    expect((await ctx.patch(path, {}, otherTeacher.token)).status).toBe(404);
  });

  test('a training outside the caller’s school is 404 to enrol in', async () => {
    const created = (await post({ title: 'B-only workshop', requirement: 'optional', credits: 0 }, b.schoolAdmin.token)).body.training;
    expect((await ctx.post(`${TRAININGS}/${created.id}/enrolment`, {}, a.teacher.token)).status).toBe(404);
  });

  test('only a teacher or psychologist enrols; a school admin cannot', async () => {
    const created = (await post({ title: 'Admin-only test', requirement: 'optional', credits: 0 }, a.schoolAdmin.token)).body.training;
    expect((await ctx.post(`${TRAININGS}/${created.id}/enrolment`, {}, a.schoolAdmin.token)).status).toBe(403);
    expect((await ctx.post(`${TRAININGS}/${created.id}/enrolment`, {}, a.parent.token)).status).toBe(403);
  });
});
