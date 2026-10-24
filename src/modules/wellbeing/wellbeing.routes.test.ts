// Consent, wellbeing check-ins, support plans and notifications — Supertest over HTTP against
// the real app + PostgreSQL, with a FIXED clock: NOW = 2026-11-03T20:00:00Z = 2026-11-04 01:30
// in Asia/Kolkata, so "today" is 4 November in IST.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { createSchoolFixture, newAccount, type Account, type SchoolFixture } from '../../../test/support/fixtures.js';

const NOW = new Date('2026-11-03T20:00:00.000Z');

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let psych: Account;

beforeAll(async () => {
  ctx = await createTestContext({ now: () => NOW });
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  psych = await newAccount(ctx, rootToken, 'psychologist');
});

afterAll(async () => {
  await ctx?.close();
});

const students = (id: string, path: string) => `/api/v1/students/${id}/${path}`;
const allow = (purpose: string, granted: boolean, f: SchoolFixture = a) =>
  ctx.send('PUT', students(f.student.id, `consents/${purpose}`), { body: { granted }, token: f.parent.token });

describe('consent', () => {
  test('starts as not allowed, and only the parent can change it', async () => {
    const before = await ctx.get(students(b.student.id, 'consents'), b.parent.token);
    expect(before.status).toBe(200);
    expect(before.body.consents.map((c: { granted: boolean }) => c.granted)).toEqual([false, false]);

    const byStudent = await ctx.send('PUT', students(b.student.id, 'consents/wellness_tracking'), { body: { granted: true }, token: b.student.token });
    expect(byStudent.status).toBe(403);
    const byTeacher = await ctx.send('PUT', students(b.student.id, 'consents/wellness_tracking'), { body: { granted: true }, token: b.teacher.token });
    expect(byTeacher.status).toBe(403);
    expect((await allow('wellness_tracking', true, b)).body.consent).toMatchObject({ purpose: 'wellness_tracking', granted: true });
  });

  test("another family's parent reaches nothing (404)", async () => {
    const r = await ctx.send('PUT', students(a.student.id, 'consents/wellness_tracking'), { body: { granted: true }, token: b.parent.token });
    expect(r.status).toBe(404);
  });

  test('rejects an unknown purpose', async () => {
    const r = await ctx.send('PUT', students(a.student.id, 'consents/everything'), { body: { granted: true }, token: a.parent.token });
    expect(r.status).toBe(400);
  });
});

describe('wellbeing check-ins', () => {
  const checkin = (f: SchoolFixture, body: unknown, token = f.student.token) => ctx.post(students(f.student.id, 'wellness-checkins'), body, token);

  test('are refused until the family allows tracking', async () => {
    const r = await checkin(a, { mood: 4, energy: 3 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CONSENT_REQUIRED');
  });

  test('record today in Asia/Kolkata, and a second one replaces the first', async () => {
    await allow('wellness_tracking', true);
    const first = await checkin(a, { mood: 4, energy: 3, sleepMinutes: 480 });
    expect(first.status).toBe(201);
    expect(first.body.checkin).toMatchObject({ day: '2026-11-04', mood: 4, sleepMinutes: 480 });
    expect((await checkin(a, { mood: 2, energy: 2 }, a.parent.token)).status).toBe(201);

    const list = await ctx.get(students(a.student.id, 'wellness-checkins'), a.parent.token);
    expect(list.body).toMatchObject({ isTracking: true, isVisible: true });
    expect(list.body.checkins).toHaveLength(1);
    expect(list.body.checkins[0]).toMatchObject({ mood: 2, energy: 2, sleepMinutes: null });
  });

  test('validate their ranges and days', async () => {
    expect((await checkin(a, { mood: 6, energy: 3 })).status).toBe(400);
    expect((await checkin(a, { mood: 3, energy: 0 })).status).toBe(400);
    expect((await checkin(a, { mood: 3, energy: 3, day: '2026-11-05' })).status).toBe(400);
    expect((await checkin(a, { mood: 3, energy: 3, day: '2026-09-01' })).status).toBe(400);
    expect((await checkin(a, { mood: 3, energy: 3, extra: true })).status).toBe(400);
  });

  test('teachers see none until the family shares with the school', async () => {
    const hidden = await ctx.get(students(a.student.id, 'wellness-checkins'), a.teacher.token);
    expect(hidden.body).toMatchObject({ isTracking: true, isSharedWithSchool: false, isVisible: false, checkins: [] });

    await allow('wellness_sharing', true);
    const shared = await ctx.get(students(a.student.id, 'wellness-checkins'), a.teacher.token);
    expect(shared.body.isVisible).toBe(true);
    expect(shared.body.checkins).toHaveLength(1);

    await allow('wellness_tracking', false);
    expect((await ctx.get(students(a.student.id, 'wellness-checkins'), a.teacher.token)).body.isVisible).toBe(false);
  });

  test('a teacher from another school reaches nothing (404), and staff cannot record', async () => {
    expect((await ctx.get(students(a.student.id, 'wellness-checkins'), b.teacher.token)).status).toBe(404);
    expect((await ctx.post(students(a.student.id, 'wellness-checkins'), { mood: 3, energy: 3 }, a.teacher.token)).status).toBe(403);
  });
});

describe('support plans', () => {
  const plans = (f: SchoolFixture) => students(f.student.id, 'support-plans');

  test('teachers and psychologists open and read them; families never see them', async () => {
    const created = await ctx.post(plans(a), { category: 'sensory', summary: 'Loud rooms are hard.', strategies: 'A quiet corner.' }, a.teacher.token);
    expect(created.status).toBe(201);
    expect(created.body.plan).toMatchObject({ categoryLabel: 'Sensory needs', status: 'active', isReviewDue: false });

    expect((await ctx.get(plans(a), psych.token)).body.plans).toHaveLength(1);
    for (const family of [a.parent.token, a.student.token]) {
      expect((await ctx.get(plans(a), family)).status).toBe(403);
      expect((await ctx.post(plans(a), { category: 'other', summary: 'x' }, family)).status).toBe(403);
    }
  });

  test("another school's teacher reaches nothing (404)", async () => {
    expect((await ctx.get(plans(a), b.teacher.token)).status).toBe(404);
    expect((await ctx.post(plans(a), { category: 'other', summary: 'x' }, b.teacher.token)).status).toBe(404);
  });

  test('update, close and reopen', async () => {
    const created = await ctx.post(plans(a), { category: 'learning', summary: 'Needs extra time.', reviewOn: '2026-11-04' }, a.teacher.token);
    const id = created.body.plan.id as string;
    expect(created.body.plan.isReviewDue).toBe(true);

    const closed = await ctx.patch(`/api/v1/support-plans/${id}`, { status: 'closed' }, psych.token);
    expect(closed.body.plan).toMatchObject({ status: 'closed', isReviewDue: false });
    expect(closed.body.plan.closedAt).not.toBeNull();
    const reopened = await ctx.patch(`/api/v1/support-plans/${id}`, { status: 'in_review' }, a.teacher.token);
    expect(reopened.body.plan).toMatchObject({ status: 'in_review', closedAt: null });

    expect((await ctx.patch(`/api/v1/support-plans/${id}`, {}, a.teacher.token)).status).toBe(400);
    expect((await ctx.patch(`/api/v1/support-plans/${id}`, { summary: 'x' }, b.teacher.token)).status).toBe(404);
  });
});

describe('notifications', () => {
  test('a star reaches the child and the parent, and "seen" clears the count', async () => {
    const star = await ctx.post(
      '/api/v1/observations',
      { studentId: a.student.id, tone: 'positive', area: 'social', description: 'Helped a new friend settle in.', when: 'today', howOften: 'once' },
      a.teacher.token,
    );
    expect(star.status).toBe(201);

    const forParent = await ctx.get('/api/v1/notifications', a.parent.token);
    expect(forParent.status).toBe(200);
    expect(forParent.body.notifications.some((n: { kind: string }) => n.kind === 'star')).toBe(true);
    expect(forParent.body.unreadCount).toBeGreaterThan(0);
    expect(JSON.stringify(forParent.body)).not.toMatch(/concern|review/i);

    expect((await ctx.get('/api/v1/notifications', a.student.token)).body.notifications.some((n: { title: string }) => n.title === 'You earned a star')).toBe(true);

    // The clock is fixed, so everything created before NOW is read once marked seen at NOW.
    expect((await ctx.post('/api/v1/notifications/seen', {}, a.parent.token)).status).toBe(200);
    expect((await ctx.get('/api/v1/notifications', a.parent.token)).body.unreadCount).toBe(0);
  });

  test("another family hears nothing about this child", async () => {
    const other = await ctx.get('/api/v1/notifications', b.parent.token);
    expect(other.body.notifications.filter((n: { studentId: string }) => n.studentId === a.student.id)).toEqual([]);
  });

  test('is for signed-in family and staff only', async () => {
    expect((await ctx.get('/api/v1/notifications')).status).toBe(401);
    expect((await ctx.get('/api/v1/notifications', a.schoolAdmin.token)).status).toBe(403);
  });
});
