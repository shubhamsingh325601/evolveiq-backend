// Progress — Supertest over HTTP against the real app + PostgreSQL, with a FIXED clock:
//   NOW = 2026-11-03T20:00:00Z = 2026-11-04 01:30 in Asia/Kolkata
// so "today" in IST (4 Nov) differs from "today" in UTC (3 Nov): any UTC-day bug shows.
// Every relevant timestamp is set explicitly relative to NOW, so the tests don't depend on
// when they run.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import {
  MCQ,
  TEXT,
  addStudentToClass,
  createActivity,
  createSchoolFixture,
  newAccount,
  type Account,
  type SchoolFixture,
} from '../../../test/support/fixtures.js';

const NOW = new Date('2026-11-03T20:00:00.000Z');

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let psych: Account;
let activityId: string;

beforeAll(async () => {
  ctx = await createTestContext({ now: () => NOW });
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  psych = await newAccount(ctx, rootToken, 'psychologist');
  activityId = await createActivity(ctx, psych.token, TEXT, 'Daily journal');
  // All fixture students "existed" since September.
  await ctx.pg.query(`UPDATE users SET created_at = '2026-09-15T00:00:00Z' WHERE role = 'student'`);
});

afterAll(async () => {
  await ctx?.close();
});

const url = (studentId: string, path: string) => `/api/v1/students/${studentId}/${path}`;

/** A student in fixture A's class, with one completion at each given instant. */
async function studentWithCompletions(instants: string[]): Promise<Account> {
  const s = await newAccount(ctx, rootToken, 'student', SCHOOL_A);
  await ctx.pg.query(`UPDATE users SET created_at = '2026-09-15T00:00:00Z' WHERE id = $1`, [s.id]);
  await addStudentToClass(ctx, a, s.id);
  for (const instant of instants) await addCompletion(s, instant);
  return s;
}

async function addCompletion(s: Account, instant: string): Promise<void> {
  const assigned = await ctx.post('/api/v1/assignments', { studentId: s.id, activityId }, a.teacher.token);
  const assignmentId = assigned.body.assignment.id;
  const done = await ctx.post('/api/v1/activity-completions', { assignmentId, answer: { type: 'text', text: 'Done.' } }, s.token);
  if (done.status !== 201) throw new Error(`completion failed: ${done.status}`);
  await ctx.pg.query('UPDATE activity_completions SET completed_at = $1 WHERE assignment_id = $2', [instant, assignmentId]);
}

/** A reviewed teacher observation about `studentId` with this outcome / area, reviewed at `at`. */
async function reviewed(studentId: string, outcome: 'assigned' | 'no_action', developmentArea: string | undefined, at: string): Promise<void> {
  const obs = await ctx.post('/api/v1/observations', { studentId, area: 'emotions', description: 'Noted.', when: 'today', howOften: 'once' }, a.teacher.token);
  const id = obs.body.observation.id;
  const assignmentActivity = await createActivity(ctx, psych.token, MCQ, `Review activity ${id.slice(0, 8)}`);
  const body = outcome === 'assigned'
    ? { outcome, activityIds: [assignmentActivity], ...(developmentArea && { developmentArea }) }
    : { outcome, ...(developmentArea && { developmentArea }) };
  const r = await ctx.post(`/api/v1/observations/${id}/review`, body, psych.token);
  if (r.status !== 200) throw new Error(`review failed: ${r.status} ${JSON.stringify(r.body)}`);
  await ctx.pg.query('UPDATE observations SET reviewed_at = $1 WHERE id = $2', [at, id]);
}

// ─────────────────────────────── Access ───────────────────────────────
describe('who can see a student\'s progress', () => {
  const paths = ['growth-areas', 'streak', 'stars', 'monthly-summaries/2026-11', 'holistic-index', 'growth-moments'];

  test('the student, their parent, their teacher and psychologists → 200', async () => {
    for (const who of [a.student, a.parent, a.teacher, psych]) {
      for (const path of paths) expect((await ctx.get(url(a.student.id, path), who.token)).status, path).toBe(200);
    }
  });

  test("anyone else's student → 404, the same as an unknown one", async () => {
    const otherTeacher = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
    const otherParent = await newAccount(ctx, rootToken, 'parent', SCHOOL_A);
    for (const who of [b.student, b.parent, b.teacher, otherTeacher, otherParent]) {
      for (const path of paths) expect((await ctx.get(url(a.student.id, path), who.token)).status, path).toBe(404);
    }
    expect((await ctx.get(url('99999999-9999-4999-8999-999999999999', 'streak'), psych.token)).status).toBe(404);
  });

  test('School Admin and Platform Admin → 403; no token → 401', async () => {
    for (const token of [a.schoolAdmin.token, rootToken]) {
      for (const path of paths) expect((await ctx.get(url(a.student.id, path), token)).status).toBe(403);
    }
    expect((await ctx.get(url(a.student.id, 'streak'))).status).toBe(401);
  });
});

// ─────────────────────────────── Growth areas ───────────────────────────────
describe('growth areas — derived from "Assign & mark reviewed" development areas', () => {
  test('only assigned reviews with a development area count; names, newest first', async () => {
    const s = await studentWithCompletions([]);
    await reviewed(s.id, 'assigned', 'managing_feelings', '2026-10-01T10:00:00Z');
    await reviewed(s.id, 'no_action', 'motor_skills', '2026-10-02T10:00:00Z'); // no_action: ignored
    await reviewed(s.id, 'assigned', undefined, '2026-10-03T10:00:00Z'); // no area: ignored
    await reviewed(s.id, 'assigned', 'confidence', '2026-10-04T10:00:00Z');
    const r = await ctx.get(url(s.id, 'growth-areas'), psych.token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ growthAreas: [{ name: 'Confidence & self-esteem' }, { name: 'Managing feelings' }] });
  });

  test('never more than five: the five most recent, older ones drop off, nothing is rejected', async () => {
    const s = await studentWithCompletions([]);
    const areas = ['managing_feelings', 'social_skills', 'communication', 'focus_attention', 'self_control', 'confidence', 'resilience'];
    for (const [i, area] of areas.entries()) await reviewed(s.id, 'assigned', area, `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z`);
    const r = await ctx.get(url(s.id, 'growth-areas'), psych.token);
    expect(r.body.growthAreas).toEqual([
      { name: 'Coping & resilience' },
      { name: 'Confidence & self-esteem' },
      { name: 'Self-control' },
      { name: 'Focus & attention' },
      { name: 'Communication' },
    ]);
    // All seven reviews were accepted.
    expect((await ctx.pg.query(`SELECT count(*)::int AS n FROM observations WHERE student_id = $1 AND status = 'reviewed'`, [s.id])).rows[0].n).toBe(7);
  });

  test('an area tagged again moves to the front instead of appearing twice', async () => {
    const s = await studentWithCompletions([]);
    await reviewed(s.id, 'assigned', 'managing_feelings', '2026-10-01T10:00:00Z');
    await reviewed(s.id, 'assigned', 'confidence', '2026-10-02T10:00:00Z');
    await reviewed(s.id, 'assigned', 'managing_feelings', '2026-10-03T10:00:00Z');
    const r = await ctx.get(url(s.id, 'growth-areas'), psych.token);
    expect(r.body.growthAreas).toEqual([{ name: 'Managing feelings' }, { name: 'Confidence & self-esteem' }]);
  });

  test('there is no endpoint to add a growth area manually', async () => {
    expect((await ctx.post(url(a.student.id, 'growth-areas'), { name: 'X' }, psych.token)).status).toBe(404);
  });
});

// ─────────────────────────────── Stars ───────────────────────────────
describe('stars — one for every positive observation', () => {
  const STAR_KEYS = ['area', 'createdAt', 'description', 'givenBy', 'id', 'studentId'];
  const starsOf = (s: Account, token = s.token, qs = '') => ctx.get(`${url(s.id, 'stars')}${qs}`, token);

  /** Writes an observation about `studentId`; `createdAt` moves it in time. */
  async function observe(token: string, path: string, studentId: string, extra: Record<string, unknown>, createdAt?: string): Promise<string> {
    const r = await ctx.post(path, { studentId, area: 'communication', description: 'Noticed.', when: 'today', howOften: 'once', ...extra }, token);
    if (r.status !== 201) throw new Error(`observation failed: ${r.status} ${JSON.stringify(r.body)}`);
    if (createdAt) await ctx.pg.query('UPDATE observations SET created_at = $1 WHERE id = $2', [createdAt, r.body.observation.id]);
    return r.body.observation.id as string;
  }

  test('nothing positive yet → no stars', async () => {
    const s = await studentWithCompletions([]);
    const r = await starsOf(s);
    expect(r.status).toBe(200);
    expect(r.body.stars).toEqual([]);
    expect(r.body.pagination.total).toBe(0);
  });

  test("a teacher's and a parent's positive observations are stars, newest first; concerns are not", async () => {
    const s = await studentWithCompletions([]);
    const parent = await newAccount(ctx, rootToken, 'parent', SCHOOL_A);
    await ctx.post('/api/v1/parent-students', { parentId: parent.id, studentId: s.id }, a.schoolAdmin.token);
    const fromTeacher = await observe(
      a.teacher.token,
      '/api/v1/observations',
      s.id,
      { tone: 'positive', description: 'Explained the museum trip to the whole class.', learningBehaviourArea: 'participation' },
      '2026-11-01T05:00:00Z',
    );
    const fromParent = await observe(parent.token, '/api/v1/family/observations', s.id, { tone: 'positive', area: 'routines' }, '2026-11-02T05:00:00Z');
    await observe(a.teacher.token, '/api/v1/observations', s.id, { description: 'Found the fire drill very hard.' }); // a concern

    for (const who of [s, parent, a.teacher, psych]) {
      const r = await starsOf(s, who.token);
      expect(r.status).toBe(200);
      expect(r.body.stars.map((star: { id: string }) => star.id)).toEqual([fromParent, fromTeacher]);
      expect(r.body.pagination.total).toBe(2);
    }
    const r = await starsOf(s);
    expect(r.body.stars[1]).toEqual({
      id: fromTeacher,
      studentId: s.id,
      area: 'communication',
      description: 'Explained the museum trip to the whole class.',
      givenBy: { fullName: expect.any(String), role: 'teacher' },
      createdAt: '2026-11-01T05:00:00.000Z',
    });
    expect(r.body.stars[0].givenBy).toEqual({ fullName: expect.any(String), role: 'parent' });
    for (const star of r.body.stars) expect(Object.keys(star).sort()).toEqual(STAR_KEYS);
    // The learning-behaviour area is a teacher-only field: never part of a star.
    expect(JSON.stringify(r.body)).not.toContain('participation');
  });

  test('paged like every list; `limit=1` still gives the count', async () => {
    const s = await studentWithCompletions([]);
    for (const day of ['01', '02', '03']) {
      await observe(a.teacher.token, '/api/v1/observations', s.id, { tone: 'positive' }, `2026-11-${day}T05:00:00Z`);
    }
    const r = await starsOf(s, s.token, '?limit=1&page=2');
    expect(r.body.stars).toHaveLength(1);
    expect(r.body.stars[0].createdAt).toBe('2026-11-02T05:00:00.000Z');
    expect(r.body.pagination).toMatchObject({ page: 2, limit: 1, total: 3, totalPages: 3 });
    expect((await starsOf(s, s.token, '?limit=0')).status).toBe(400);
  });

  test("a month's stars are counted in its summary", async () => {
    const s = await studentWithCompletions([]);
    await observe(a.teacher.token, '/api/v1/observations', s.id, { tone: 'positive' }, '2026-11-02T05:00:00Z');
    await observe(a.teacher.token, '/api/v1/observations', s.id, { tone: 'positive' }, '2026-10-20T05:00:00Z');
    await observe(a.teacher.token, '/api/v1/observations', s.id, {}, '2026-11-02T06:00:00Z'); // a concern: no star
    const november = await ctx.get(url(s.id, 'monthly-summaries/2026-11'), s.token);
    expect(november.body.summary.text).toMatch(/ has earned 1 star this month\.$/);
    const october = await ctx.get(url(s.id, 'monthly-summaries/2026-10'), s.token);
    expect(october.body.summary.text).toMatch(/ earned 1 star that month\.$/);
  });
});

// ─────────────────────────────── Streak ───────────────────────────────
describe('streak — consecutive Asia/Kolkata days', () => {
  const streakOf = async (s: Account) => (await ctx.get(url(s.id, 'streak'), s.token)).body.streak.days as number;

  test('no completions → 0', async () => {
    expect(await streakOf(await studentWithCompletions([]))).toBe(0);
  });

  test('uses IST days, not UTC days', async () => {
    // IST 4 Nov 00:30, IST 3 Nov 15:30, IST 2 Nov 00:15. In UTC the first two are the same
    // day (3 Nov) and the third is 1 Nov, which would give 1 — in IST it is 3 days in a row.
    const s = await studentWithCompletions(['2026-11-03T19:00:00Z', '2026-11-03T10:00:00Z', '2026-11-01T18:45:00Z']);
    expect(await streakOf(s)).toBe(3);
  });

  test('today (IST) not completed yet → counts from yesterday', async () => {
    // Latest completion: IST 3 Nov 23:59 (UTC 18:29) — yesterday in IST at NOW.
    const s = await studentWithCompletions(['2026-11-03T18:29:00Z', '2026-11-02T08:00:00Z']);
    expect(await streakOf(s)).toBe(2);
  });

  test('a completion one minute after IST midnight counts for today', async () => {
    const s = await studentWithCompletions(['2026-11-03T18:31:00Z']); // IST 4 Nov 00:01
    expect(await streakOf(s)).toBe(1);
  });

  test('a missed IST day breaks it', async () => {
    const s = await studentWithCompletions(['2026-11-03T19:00:00Z', '2026-11-02T08:00:00Z']); // 4 Nov, 2 Nov (3 Nov missed)
    expect(await streakOf(s)).toBe(1);
  });

  test('neither today nor yesterday → 0', async () => {
    const s = await studentWithCompletions(['2026-11-02T08:00:00Z', '2026-11-01T08:00:00Z']); // IST 2 Nov, 1 Nov
    expect(await streakOf(s)).toBe(0);
  });

  test('crosses the month boundary and counts every day of the week', async () => {
    // IST 4 Nov back to 28 Oct: 8 consecutive days (28 Oct 2026 is a Wednesday).
    const instants = ['2026-11-03T19:00:00Z', '2026-11-02T19:00:00Z', '2026-11-01T19:00:00Z', '2026-10-31T19:00:00Z', '2026-10-30T19:00:00Z', '2026-10-29T19:00:00Z', '2026-10-28T19:00:00Z', '2026-10-27T19:00:00Z'];
    expect(await streakOf(await studentWithCompletions(instants))).toBe(8);
  });

  test('several completions on one day count once; completions after NOW are ignored', async () => {
    const s = await studentWithCompletions(['2026-11-03T19:00:00Z', '2026-11-03T19:30:00Z', '2026-11-05T10:00:00Z']);
    expect(await streakOf(s)).toBe(1);
  });
});

// ─────────────────────────────── Monthly summary ───────────────────────────────
describe('monthly summary', () => {
  const summary = (s: Account, month: string, token = s.token) => ctx.get(url(s.id, `monthly-summaries/${month}`), token);
  const storedRows = async (s: Account) => (await ctx.pg.query('SELECT to_char(month, \'YYYY-MM-DD\') AS month, summary FROM monthly_summaries WHERE student_id = $1', [s.id])).rows;

  test('current month (November in IST) is built live and not stored; IST month boundaries', async () => {
    // IST 1 Nov 00:15 (UTC 31 Oct) → November. IST 31 Oct 23:45 (UTC 31 Oct 18:15) → October.
    const s = await studentWithCompletions(['2026-10-31T18:45:00Z', '2026-10-31T18:15:00Z']);
    const r = await summary(s, '2026-11');
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ studentId: s.id, month: '2026-11', isFinal: false });
    expect(r.body.summary.text).toMatch(/^So far in November 2026, .+ has completed 1 activity on 1 day\.$/);
    expect(await storedRows(s)).toEqual([]);

    await addCompletion(s, '2026-11-02T05:00:00Z');
    const again = await summary(s, '2026-11');
    expect(again.body.summary.text).toContain('has completed 2 activities on 2 different days');
    expect(await storedRows(s)).toEqual([]);
  });

  test('a finished month is stored on first request and never changes afterwards', async () => {
    const s = await studentWithCompletions(['2026-10-31T18:15:00Z', '2026-10-30T10:00:00Z', '2026-10-29T10:00:00Z']);
    await reviewed(s.id, 'assigned', 'resilience', '2026-10-20T10:00:00Z');
    const first = await summary(s, '2026-10', a.teacher.token);
    expect(first.status).toBe(200);
    expect(first.body.summary.isFinal).toBe(true);
    expect(first.body.summary.text).toMatch(
      /^In October 2026, .+ completed 3 activities on 3 different days\. Their longest streak was 3 days in a row\. Areas .+ is working on: Coping & resilience\.$/,
    );
    expect(await storedRows(s)).toEqual([{ month: '2026-10-01', summary: first.body.summary.text }]);

    // New October data (and a new growth area) after the fact: the stored summary stands.
    await addCompletion(s, '2026-10-15T10:00:00Z');
    await reviewed(s.id, 'assigned', 'confidence', '2026-10-25T10:00:00Z');
    for (const who of [s, a.teacher, psych]) {
      const later = await summary(s, '2026-10', who.token);
      expect(later.body.summary.text).toBe(first.body.summary.text);
    }
    expect(await storedRows(s)).toHaveLength(1);
  });

  test('the database itself refuses to change or delete a stored summary', async () => {
    const s = await studentWithCompletions([]);
    await summary(s, '2026-10');
    await expect(ctx.pg.query(`UPDATE monthly_summaries SET summary = 'rewritten' WHERE student_id = $1`, [s.id])).rejects.toThrow(/immutable/);
    await expect(ctx.pg.query('DELETE FROM monthly_summaries WHERE student_id = $1', [s.id])).rejects.toThrow(/immutable/);
  });

  test('a past month\'s growth areas are those as of that month\'s end (IST)', async () => {
    const s = await studentWithCompletions([]);
    await reviewed(s.id, 'assigned', 'resilience', '2026-10-31T18:00:00Z'); // IST 31 Oct 23:30 → in October
    await reviewed(s.id, 'assigned', 'confidence', '2026-10-31T18:45:00Z'); // IST 1 Nov 00:15 → after October
    const october = await summary(s, '2026-10');
    expect(october.body.summary.text).toContain('working on: Coping & resilience.');
    expect(october.body.summary.text).not.toContain('Confidence');
    const november = await summary(s, '2026-11');
    expect(november.body.summary.text).toContain('Confidence & self-esteem and Coping & resilience');
  });

  test('concurrent first requests for a finished month store exactly one row', async () => {
    const s = await studentWithCompletions(['2026-10-10T10:00:00Z']);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => summary(s, '2026-10')));
    expect(new Set(results.map((r) => r.body.summary.text)).size).toBe(1);
    expect(await storedRows(s)).toHaveLength(1);
  });

  test('future month → 400; before the student existed → 404; bad format → 400', async () => {
    const s = await studentWithCompletions([]);
    const future = await summary(s, '2026-12');
    expect(future.status).toBe(400);
    expect(future.body.error.details).toEqual([{ field: 'month', message: 'must not be in the future' }]);
    expect((await summary(s, '2026-08')).status).toBe(404);
    for (const bad of ['2026-13', '2026-1', '26-10', 'october']) expect((await summary(s, bad)).status, bad).toBe(400);
  });

  test('parent-safe: the text never contains clinical data', async () => {
    const s = await studentWithCompletions(['2026-11-01T05:00:00Z']);
    await ctx.post('/api/v1/parent-students', { parentId: (await newAccount(ctx, rootToken, 'parent', SCHOOL_A)).id, studentId: s.id }, a.schoolAdmin.token);
    const obs = await ctx.post('/api/v1/observations', { studentId: s.id, area: 'behaviour', description: 'Hit a classmate.', when: 'today', howOften: 'once', level: 'significant', learningBehaviourArea: 'self_control' }, a.teacher.token);
    await ctx.post(`/api/v1/observations/${obs.body.observation.id}/review`, { outcome: 'assigned', activityIds: [activityId], developmentArea: 'self_control', teacherOnlyNote: 'Refer to counsellor.' }, psych.token);
    const r = await summary(s, '2026-11');
    for (const secret of ['Hit a classmate', 'significant', 'Significant', 'Refer to counsellor', 'self_control', 'behaviour', psych.id, 'Done.']) {
      expect(r.body.summary.text, secret).not.toContain(secret);
    }
    expect(Object.keys(r.body.summary).sort()).toEqual(['isFinal', 'month', 'studentId', 'text']);
  });
});
