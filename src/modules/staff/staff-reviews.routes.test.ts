// Staff reviews — Supertest over HTTP against the real app + PostgreSQL, with a FIXED clock:
// NOW = 2026-11-03T20:00:00Z = 2026-11-04 in Asia/Kolkata, so the current month is 2026-11.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { createSchoolFixture, newAccount, type Account, type SchoolFixture } from '../../../test/support/fixtures.js';

const NOW = new Date('2026-11-03T20:00:00.000Z');

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let colleague: Account;

beforeAll(async () => {
  ctx = await createTestContext({ now: () => NOW });
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  colleague = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
});

afterAll(async () => {
  await ctx?.close();
});

const REVIEWS = '/api/v1/staff-reviews';
const GOOD = { teaching: 5, engagement: 4, punctuality: 5, teamwork: 4, communication: 4, comment: 'Calm, well-planned lessons.' };
const rate = (staffId: string, month: string, body: unknown, token = a.schoolAdmin.token) =>
  ctx.send('PUT', `${REVIEWS}/${staffId}/${month}`, { body, token });

describe('rating a teacher', () => {
  test("the school admin rates a teacher's month, and a second rating replaces it", async () => {
    const first = await rate(a.teacher.id, '2026-10', GOOD);
    expect(first.status).toBe(200);
    expect(first.body.review).toMatchObject({
      staff: { id: a.teacher.id },
      month: '2026-10',
      ratings: { teaching: 5, engagement: 4, punctuality: 5, teamwork: 4, communication: 4 },
      average: 4.4,
      comment: 'Calm, well-planned lessons.',
    });

    const second = await rate(a.teacher.id, '2026-10', { teaching: 3, engagement: 3, punctuality: 3, teamwork: 3, communication: 3 });
    expect(second.body.review).toMatchObject({ id: first.body.review.id, average: 3, comment: null });
    await rate(colleague.id, '2026-10', GOOD);
    await rate(a.teacher.id, '2026-11', GOOD);

    const october = await ctx.get(`${REVIEWS}?month=2026-10`, a.schoolAdmin.token);
    expect(october.status).toBe(200);
    expect(october.body.reviews).toHaveLength(2);
    const all = await ctx.get(REVIEWS, a.schoolAdmin.token);
    expect(all.body.reviews.map((r: { month: string }) => r.month)).toEqual(['2026-11', '2026-10', '2026-10']);
  });

  test('a teacher reads only their own reviews', async () => {
    const own = await ctx.get(REVIEWS, a.teacher.token);
    expect(own.status).toBe(200);
    expect(own.body.reviews.every((r: { staff: { id: string } }) => r.staff.id === a.teacher.id)).toBe(true);
    expect(own.body.reviews).toHaveLength(2);
    expect((await ctx.get(`${REVIEWS}?staffId=${colleague.id}`, a.teacher.token)).status).toBe(403);
    expect((await ctx.get(REVIEWS, b.schoolAdmin.token)).body.reviews).toEqual([]);
  });

  test('only the school admin writes, about their own school’s teachers', async () => {
    expect((await rate(a.teacher.id, '2026-10', GOOD, a.teacher.token)).status).toBe(403);
    expect((await rate(a.teacher.id, '2026-10', GOOD, rootToken)).status).toBe(403);
    expect((await rate(b.teacher.id, '2026-10', GOOD)).status).toBe(404);
    expect((await rate(a.student.id, '2026-10', GOOD)).status).toBe(404);
    expect((await ctx.get(REVIEWS, a.parent.token)).status).toBe(403);
    expect((await ctx.get(REVIEWS, rootToken)).status).toBe(403);
  });

  test('ratings are 1–5 on every criterion, and never for a future month', async () => {
    expect((await rate(a.teacher.id, '2026-12', GOOD)).status).toBe(400);
    expect((await rate(a.teacher.id, '2026-10', { ...GOOD, teaching: 6 })).status).toBe(400);
    expect((await rate(a.teacher.id, '2026-10', { ...GOOD, teamwork: 0 })).status).toBe(400);
    const { communication: _left, ...missing } = GOOD;
    expect((await rate(a.teacher.id, '2026-10', missing)).status).toBe(400);
    expect((await rate(a.teacher.id, '2026-13', GOOD)).status).toBe(400);
  });

  test('a review can be taken back', async () => {
    expect((await ctx.del(`${REVIEWS}/${colleague.id}/2026-10`, b.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.del(`${REVIEWS}/${colleague.id}/2026-10`, a.schoolAdmin.token)).status).toBe(204);
    expect((await ctx.del(`${REVIEWS}/${colleague.id}/2026-10`, a.schoolAdmin.token)).status).toBe(404);
  });
});
