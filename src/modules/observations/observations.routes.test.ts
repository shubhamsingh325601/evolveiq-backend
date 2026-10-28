// Observations — Supertest over HTTP against the real app + PostgreSQL.
// Parent / teacher creation (enums, teacher-only fields, scope), who sees what (allow-listed
// DTOs, nothing clinical for parents), the psychologist's queue / detail / history, and the
// review: one per observation (409), Significant needs a development area, assignments
// created atomically with the review (rollback proven with injected failures). Positive
// observations: celebrated at once, never reviewed, never given a Level.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import {
  MCQ,
  RATING,
  addStudentToClass,
  createActivity,
  createSchoolFixture,
  newAccount,
  type Account,
  type SchoolFixture,
} from '../../../test/support/fixtures.js';

const OBS = '/api/v1/observations';
const FAMILY = '/api/v1/family/observations';
const PARENT_KEYS = ['area', 'createdAt', 'description', 'howOften', 'id', 'status', 'studentId', 'tone', 'when'];
const TEACHER_KEYS = [...PARENT_KEYS, 'learningBehaviourArea', 'level', 'reviewedAt', 'teacherOnlyNote'].sort();

let ctx: TestContext;
let rootToken: string;
let a: SchoolFixture;
let b: SchoolFixture;
let psych: Account;
let activityA: string;
let activityB: string;

const base = { area: 'emotions', description: 'Cried at drop-off again.', when: 'this_week', howOften: 'often' };

beforeAll(async () => {
  ctx = await createTestContext();
  rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  psych = await newAccount(ctx, rootToken, 'psychologist');
  activityA = await createActivity(ctx, psych.token, MCQ, 'Feelings check-in');
  activityB = await createActivity(ctx, psych.token, RATING, 'Sleep rating');
});

afterAll(async () => {
  await ctx?.close();
});

const asTeacher = (body: unknown, token = a.teacher.token) => ctx.post(OBS, body, token);
const asParent = (body: unknown, token = a.parent.token) => ctx.post(FAMILY, body, token);
const review = (id: string, body: unknown, token = psych.token) => ctx.post(`${OBS}/${id}/review`, body, token);
const teacherObservation = async (extra: Record<string, unknown> = {}, f: SchoolFixture = a) => {
  const r = await asTeacher({ studentId: f.student.id, ...base, ...extra }, f.teacher.token);
  if (r.status !== 201) throw new Error(`teacher observation failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.observation.id as string;
};
const parentObservation = async (f: SchoolFixture = a) => {
  const r = await asParent({ studentId: f.student.id, ...base }, f.parent.token);
  if (r.status !== 201) throw new Error(`parent observation failed: ${r.status}`);
  return r.body.observation.id as string;
};
const dbObservation = async (id: string) => (await ctx.pg.query('SELECT * FROM observations WHERE id = $1', [id])).rows[0];
const assignmentsFor = async (id: string) =>
  (await ctx.pg.query('SELECT * FROM assignments WHERE observation_id = $1 ORDER BY created_at', [id])).rows;

// ─────────────────────────────── RBAC ───────────────────────────────
describe('RBAC', () => {
  test('no token → 401 everywhere', async () => {
    for (const [method, url] of [['POST', OBS], ['GET', OBS], ['GET', `${OBS}/mine`], ['POST', FAMILY], ['GET', FAMILY]] as const) {
      expect((await ctx.send(method, url, { body: method === 'POST' ? {} : undefined })).status, `${method} ${url}`).toBe(401);
    }
  });

  test('each route admits only its audience (403 otherwise)', async () => {
    const id = await teacherObservation();
    const cases: [string, string, Account[], unknown?][] = [
      ['POST', OBS, [a.parent, a.student, a.schoolAdmin, psych], { studentId: a.student.id, ...base }],
      ['GET', `${OBS}/mine`, [a.parent, a.student, a.schoolAdmin, psych]],
      ['GET', OBS, [a.teacher, a.parent, a.student, a.schoolAdmin]],
      ['GET', `${OBS}/${id}`, [a.teacher, a.parent, a.student, a.schoolAdmin]],
      ['POST', `${OBS}/${id}/review`, [a.teacher, a.parent, a.student, a.schoolAdmin], { outcome: 'no_action' }],
      ['POST', FAMILY, [a.teacher, a.student, a.schoolAdmin, psych], { studentId: a.student.id, ...base }],
      ['GET', FAMILY, [a.teacher, a.student, a.schoolAdmin, psych]],
    ];
    for (const [method, url, denied, body] of cases) {
      for (const who of denied) {
        const r = await ctx.send(method as 'GET' | 'POST', url, { body, token: who.token });
        expect(r.status, `${method} ${url}`).toBe(403);
      }
    }
    const platform = await ctx.send('GET', OBS, { token: rootToken });
    expect(platform.status).toBe(403);
    expect((await dbObservation(id)).status).toBe('pending');
  });
});

// ─────────────────────────────── Create ───────────────────────────────
describe('teacher creates', () => {
  test('201 with the teacher view; teacher-only fields stored', async () => {
    const r = await asTeacher({ studentId: a.student.id, ...base, level: 'moderate', learningBehaviourArea: 'task_completion' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.observation).sort()).toEqual(TEACHER_KEYS);
    expect(r.body.observation).toMatchObject({ ...base, tone: 'concern', level: 'moderate', learningBehaviourArea: 'task_completion', status: 'pending', teacherOnlyNote: null });
    const row = await dbObservation(r.body.observation.id);
    expect(row).toMatchObject({ author_role: 'teacher', school_id: SCHOOL_A, student_id: a.student.id, level: 'moderate', tone: 'concern' });
  });

  test('Level and learning-behaviour area are optional', async () => {
    const r = await asTeacher({ studentId: a.student.id, ...base });
    expect(r.status).toBe(201);
    expect(r.body.observation).toMatchObject({ level: null, learningBehaviourArea: null });
  });

  test("a student outside the teacher's classes → 422 (same as unknown), nothing written", async () => {
    const elsewhere = await newAccount(ctx, rootToken, 'student', SCHOOL_A); // same school, no class
    const before = (await ctx.pg.query('SELECT count(*)::int AS n FROM observations')).rows[0].n;
    for (const studentId of [elsewhere.id, b.student.id, a.parent.id, '99999999-9999-4999-8999-999999999999']) {
      const r = await asTeacher({ studentId, ...base });
      expect(r.status).toBe(422);
      expect(r.body.error.details).toEqual({ field: 'studentId' });
    }
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM observations')).rows[0].n).toBe(before);
  });

  test("another teacher's student (other class, same school) → 422", async () => {
    const otherTeacher = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
    expect((await asTeacher({ studentId: a.student.id, ...base }, otherTeacher.token)).status).toBe(422);
  });

  test.each([
    ['area', { area: 'feelings' }],
    ['when', { when: 'yesterday' }],
    ['howOften', { howOften: 'always' }],
    ['level', { level: 'severe' }],
    ['learningBehaviourArea', { learningBehaviourArea: 'reading' }],
    ['tone', { tone: 'negative' }],
    ['description', { description: '   ' }],
    ['description', { description: 'x'.repeat(2001) }],
  ])('invalid %s → 400', async (field, extra) => {
    const r = await asTeacher({ studentId: a.student.id, ...base, ...extra });
    expect(r.status).toBe(400);
    expect(r.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  test('every documented value of every list is accepted', async () => {
    const lists = {
      tone: ['positive', 'concern'],
      area: ['emotions', 'behaviour', 'social', 'learning', 'communication', 'physical', 'routines', 'other'],
      when: ['today', 'this_week', 'this_month', 'over_a_month'],
      howOften: ['once', 'sometimes', 'often', 'daily'],
      level: ['minor', 'moderate', 'significant'],
      learningBehaviourArea: ['attention', 'participation', 'following_instructions', 'task_completion', 'organisation', 'working_with_others', 'self_control', 'other'],
    };
    for (const [field, values] of Object.entries(lists)) {
      for (const value of values) {
        expect((await asTeacher({ studentId: a.student.id, ...base, [field]: value })).status, `${field}=${value}`).toBe(201);
      }
    }
  });
});

describe('parent creates', () => {
  test('201 with the parent view only', async () => {
    const r = await asParent({ studentId: a.student.id, ...base });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.observation).sort()).toEqual(PARENT_KEYS);
    expect(r.body.observation).toMatchObject({ ...base, tone: 'concern', status: 'pending', studentId: a.student.id });
    expect((await dbObservation(r.body.observation.id))).toMatchObject({ author_role: 'parent', level: null, learning_behaviour_area: null });
  });

  test('a positive one is celebrated straight away', async () => {
    const r = await asParent({ studentId: a.student.id, ...base, tone: 'positive', description: 'Tied her shoelaces on her own.' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.observation).sort()).toEqual(PARENT_KEYS);
    expect(r.body.observation).toMatchObject({ tone: 'positive', status: 'celebrated' });
  });

  test.each([
    ['level', { level: 'minor' }],
    ['learningBehaviourArea', { learningBehaviourArea: 'attention' }],
  ])('a parent sending %s → 400 (not silently ignored), nothing written', async (field, extra) => {
    const before = (await ctx.pg.query('SELECT count(*)::int AS n FROM observations')).rows[0].n;
    const r = await asParent({ studentId: a.student.id, ...base, ...extra });
    expect(r.status).toBe(400);
    expect(r.body.error.details).toContainEqual({ field, message: 'is not allowed' });
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM observations')).rows[0].n).toBe(before);
  });

  test('only about their own children → 422 otherwise', async () => {
    const notMine = await newAccount(ctx, rootToken, 'student', SCHOOL_A);
    for (const studentId of [notMine.id, b.student.id]) {
      expect((await asParent({ studentId, ...base })).status).toBe(422);
    }
  });
});

// ─────────────────────────────── Visibility ───────────────────────────────
describe('who sees what', () => {
  test('a teacher sees only observations they wrote', async () => {
    const mine = await teacherObservation();
    const colleague = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
    await ctx.put(`/api/v1/classes/${a.classId}/teachers/${colleague.id}`, a.schoolAdmin.token);
    const theirs = (await asTeacher({ studentId: a.student.id, ...base }, colleague.token)).body.observation.id;
    const fromParent = await parentObservation();

    const r = await ctx.get(`${OBS}/mine?limit=100`, a.teacher.token);
    expect(r.status).toBe(200);
    const ids = r.body.observations.map((o: { id: string }) => o.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect(ids).not.toContain(fromParent);
    const { rows } = await ctx.pg.query('SELECT id FROM observations WHERE author_id = $1', [a.teacher.id]);
    expect(ids.sort()).toEqual(rows.map((x: { id: string }) => x.id).sort());
    for (const o of r.body.observations) expect(Object.keys(o).sort()).toEqual(TEACHER_KEYS);
  });

  test('a parent sees only observations they wrote — never teacher ones about their own child', async () => {
    const teacherAboutChild = await teacherObservation({ level: 'significant' });
    const mine = await parentObservation();
    const r = await ctx.get(`${FAMILY}?limit=100`, a.parent.token);
    const ids = r.body.observations.map((o: { id: string }) => o.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(teacherAboutChild);
    const { rows } = await ctx.pg.query('SELECT id FROM observations WHERE author_id = $1', [a.parent.id]);
    expect(ids.sort()).toEqual(rows.map((x: { id: string }) => x.id).sort());
  });

  test('after review, the parent sees the status — and nothing clinical', async () => {
    const id = await parentObservation();
    const r = await review(id, { outcome: 'assigned', activityIds: [activityA], developmentArea: 'managing_feelings', teacherOnlyNote: 'Watch transitions; clinical note.' });
    expect(r.status).toBe(200);
    const list = await ctx.get(`${FAMILY}?limit=100`, a.parent.token);
    const mine = list.body.observations.find((o: { id: string }) => o.id === id);
    expect(mine.status).toBe('reviewed');
    expect(Object.keys(mine).sort()).toEqual(PARENT_KEYS);
    const raw = JSON.stringify(list.body);
    for (const secret of ['managing_feelings', 'clinical note', 'teacherOnlyNote', 'developmentArea', 'level', 'reviewedBy', psych.id, activityA]) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  test("after review, the authoring teacher sees status and the teacher-only note, but no reviewer or development area", async () => {
    const id = await teacherObservation({ level: 'minor' });
    await review(id, { outcome: 'no_action', developmentArea: 'focus_attention', teacherOnlyNote: 'Seat near the front.' });
    const list = await ctx.get(`${OBS}/mine?limit=100`, a.teacher.token);
    const mine = list.body.observations.find((o: { id: string }) => o.id === id);
    expect(mine).toMatchObject({ status: 'reviewed', teacherOnlyNote: 'Seat near the front.' });
    expect(Object.keys(mine).sort()).toEqual(TEACHER_KEYS);
    expect(JSON.stringify(mine)).not.toContain('focus_attention');
    expect(JSON.stringify(mine)).not.toContain(psych.id);
  });

  test('status filter on own lists', async () => {
    const r = await ctx.get(`${OBS}/mine?status=reviewed&limit=100`, a.teacher.token);
    expect(r.body.observations.every((o: { status: string }) => o.status === 'reviewed')).toBe(true);
    expect((await ctx.get(`${OBS}/mine?status=done`, a.teacher.token)).status).toBe(400);
  });
});

// ─────────────────────────────── Psychologist queue ───────────────────────────────
describe('psychologist queue, detail and history', () => {
  const ids = (r: { body: { observations: { id: string }[] } }) => r.body.observations.map((o) => o.id).sort();
  const dbIds = async (where: string, params: unknown[] = []) =>
    (await ctx.pg.query(`SELECT id FROM observations ${where}`, params)).rows.map((x: { id: string }) => x.id).sort();

  test('sees every school; filters Pending, Significant, From parents, Reviewed, by school', async () => {
    await teacherObservation({ level: 'significant' }, b);
    await parentObservation(b);
    const q = (qs: string) => ctx.get(`${OBS}?limit=100&${qs}`, psych.token);
    expect(ids(await q(''))).toEqual(await dbIds(''));
    expect(ids(await q('status=pending'))).toEqual(await dbIds(`WHERE status = 'pending'`));
    expect(ids(await q('status=reviewed'))).toEqual(await dbIds(`WHERE status = 'reviewed'`));
    expect(ids(await q('level=significant'))).toEqual(await dbIds(`WHERE level = 'significant'`));
    expect(ids(await q('authorRole=parent'))).toEqual(await dbIds(`WHERE author_role = 'parent'`));
    expect(ids(await q(`schoolId=${SCHOOL_B}`))).toEqual(await dbIds('WHERE school_id = $1', [SCHOOL_B]));
    expect(ids(await q(`status=pending&level=significant&schoolId=${SCHOOL_B}`))).toEqual(
      await dbIds(`WHERE status = 'pending' AND level = 'significant' AND school_id = $1`, [SCHOOL_B]));
    for (const bad of ['status=open', 'level=high', 'authorRole=psychologist', 'schoolId=x', 'sortBy=level', 'other=1']) {
      expect((await q(bad)).status, bad).toBe(400);
    }
  });

  test('queue items carry the full review view', async () => {
    const id = await teacherObservation({ level: 'moderate', learningBehaviourArea: 'attention' });
    const r = await ctx.get(`${OBS}?limit=100`, psych.token);
    const item = r.body.observations.find((o: { id: string }) => o.id === id);
    expect(item).toMatchObject({
      schoolId: SCHOOL_A,
      student: { id: a.student.id },
      author: { id: a.teacher.id, role: 'teacher' },
      level: 'moderate',
      learningBehaviourArea: 'attention',
      status: 'pending',
      review: null,
    });
  });

  test("detail includes the student's other observations, newest first", async () => {
    const older = await parentObservation();
    const id = await teacherObservation();
    const r = await ctx.get(`${OBS}/${id}`, psych.token);
    expect(r.status).toBe(200);
    expect(r.body.observation.id).toBe(id);
    const historyIds = r.body.history.map((o: { id: string }) => o.id);
    expect(historyIds).toContain(older);
    expect(historyIds).not.toContain(id);
    const created = r.body.history.map((o: { createdAt: string }) => o.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
    expect(r.body.history.every((o: { student: { id: string } }) => o.student.id === a.student.id)).toBe(true);
    expect(r.body.history.length).toBeLessThanOrEqual(20);
  });

  test('unknown → 404; malformed → 400', async () => {
    expect((await ctx.get(`${OBS}/99999999-9999-4999-8999-999999999999`, psych.token)).status).toBe(404);
    expect((await ctx.get(`${OBS}/nope`, psych.token)).status).toBe(400);
  });
});

// ─────────────────────────────── Review ───────────────────────────────
describe('review', () => {
  test('"assigned": marks reviewed and creates recommended assignments for the student', async () => {
    const id = await teacherObservation({ level: 'moderate' });
    const r = await review(id, { outcome: 'assigned', activityIds: [activityA, activityB], developmentArea: 'confidence', teacherOnlyNote: ' Praise effort. ' });
    expect(r.status).toBe(200);
    expect(r.body.observation).toMatchObject({
      status: 'reviewed',
      review: { outcome: 'assigned', developmentArea: 'confidence', teacherOnlyNote: 'Praise effort.', reviewedBy: { id: psych.id } },
    });
    expect(r.body.observation.review.activityIds.sort()).toEqual([activityA, activityB].sort());
    const rows = await assignmentsFor(id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ source: 'recommended', student_id: a.student.id, assigned_by_id: psych.id, observation_id: id });
    }
  });

  test('"no_action": marks reviewed, assigns nothing; the development area is optional', async () => {
    const id = await teacherObservation({ level: 'minor' });
    const r = await review(id, { outcome: 'no_action' });
    expect(r.status).toBe(200);
    expect(r.body.observation.review).toMatchObject({ outcome: 'no_action', developmentArea: null, teacherOnlyNote: null, activityIds: [] });
    expect(await assignmentsFor(id)).toHaveLength(0);
  });

  test('a review cannot be repeated or changed → 409, nothing changes', async () => {
    const id = await teacherObservation();
    expect((await review(id, { outcome: 'no_action' })).status).toBe(200);
    const before = await dbObservation(id);
    for (const body of [{ outcome: 'no_action' }, { outcome: 'assigned', activityIds: [activityA], developmentArea: 'resilience' }]) {
      const r = await review(id, body);
      expect(r.status).toBe(409);
      expect(r.body.error).toEqual({ code: 'CONFLICT', message: 'This observation has already been reviewed.' });
    }
    expect(await dbObservation(id)).toEqual(before);
    expect(await assignmentsFor(id)).toHaveLength(0);
  });

  test('concurrent reviews: exactly one wins, the others get 409, one set of assignments', async () => {
    const id = await teacherObservation();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => review(id, { outcome: 'assigned', activityIds: [activityA], developmentArea: 'resilience' })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await assignmentsFor(id)).toHaveLength(1);
  });

  test('Significant needs a development area → 400 without one (both outcomes), nothing saved', async () => {
    const id = await teacherObservation({ level: 'significant' });
    for (const body of [{ outcome: 'no_action' }, { outcome: 'assigned', activityIds: [activityA] }]) {
      const r = await review(id, body);
      expect(r.status).toBe(400);
      expect(r.body.error.details).toEqual([{ field: 'developmentArea', message: 'is required for Significant observations' }]);
    }
    expect((await dbObservation(id)).status).toBe('pending');
    expect(await assignmentsFor(id)).toHaveLength(0);
    expect((await review(id, { outcome: 'no_action', developmentArea: 'self_control' })).status).toBe(200);
  });

  test('every development area is accepted; "other" and unknown values → 400', async () => {
    const areas = ['managing_feelings', 'social_skills', 'communication', 'focus_attention', 'self_control', 'confidence', 'resilience', 'independence', 'learning_skills', 'motor_skills'];
    for (const developmentArea of areas) {
      const id = await teacherObservation();
      expect((await review(id, { outcome: 'no_action', developmentArea })).status, developmentArea).toBe(200);
    }
    const id = await teacherObservation();
    for (const developmentArea of ['other', 'anxiety']) {
      expect((await review(id, { outcome: 'no_action', developmentArea })).status).toBe(400);
    }
  });

  test.each([
    ['unknown outcome', { outcome: 'maybe' }],
    ['assigned without activities', { outcome: 'assigned' }],
    ['assigned with an empty list', { outcome: 'assigned', activityIds: [] }],
    ['duplicate activities', { outcome: 'assigned', activityIds: ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'] }],
    ['activities on no_action', { outcome: 'no_action', activityIds: ['11111111-1111-4111-8111-111111111111'] }],
    ['blank note', { outcome: 'no_action', teacherOnlyNote: '  ' }],
    ['unknown field', { outcome: 'no_action', status: 'reviewed' }],
  ])('%s → 400', async (_label, body) => {
    const id = await teacherObservation();
    expect((await review(id, body)).status).toBe(400);
    expect((await dbObservation(id)).status).toBe('pending');
  });

  test('unknown or archived activity → 422, the observation stays pending, no assignments', async () => {
    const archived = await createActivity(ctx, psych.token, MCQ, 'To archive');
    expect((await ctx.post(`/api/v1/activities/${archived}/archive`, undefined, psych.token)).status).toBe(200);
    const id = await teacherObservation();
    for (const activityIds of [[activityA, archived], [activityA, '99999999-9999-4999-8999-999999999999']]) {
      const r = await review(id, { outcome: 'assigned', activityIds, developmentArea: 'confidence' });
      expect(r.status).toBe(422);
      expect(r.body.error.details).toEqual({ field: 'activityIds' });
    }
    expect((await dbObservation(id)).status).toBe('pending');
    expect(await assignmentsFor(id)).toHaveLength(0);
  });

  test('unknown observation → 404', async () => {
    expect((await review('99999999-9999-4999-8999-999999999999', { outcome: 'no_action' })).status).toBe(404);
  });
});

// ─────────────────────────────── Positive observations ───────────────────────────────
describe('positive observations — stars, never reviewed', () => {
  const praise = { ...base, area: 'communication', description: 'Actively communicating, fluent in language.', tone: 'positive' };

  test('a teacher writes one: celebrated at once, no Level, learning-behaviour area allowed', async () => {
    const r = await asTeacher({ studentId: a.student.id, ...praise, learningBehaviourArea: 'participation' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.observation).sort()).toEqual(TEACHER_KEYS);
    expect(r.body.observation).toMatchObject({ tone: 'positive', status: 'celebrated', level: null, learningBehaviourArea: 'participation', reviewedAt: null });
    expect(await dbObservation(r.body.observation.id)).toMatchObject({ tone: 'positive', status: 'celebrated', reviewed_by_id: null });

    const mine = await ctx.get(`${OBS}/mine?limit=100`, a.teacher.token);
    expect(mine.body.observations.find((o: { id: string }) => o.id === r.body.observation.id)).toMatchObject({ status: 'celebrated' });
  });

  test('a Level on a positive one → 400 (something good is never Significant), nothing written', async () => {
    const before = (await ctx.pg.query('SELECT count(*)::int AS n FROM observations')).rows[0].n;
    for (const level of ['minor', 'significant']) {
      const r = await asTeacher({ studentId: a.student.id, ...praise, level });
      expect(r.status).toBe(400);
      expect(r.body.error.details).toEqual([{ field: 'level', message: 'is not allowed on a positive observation' }]);
    }
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM observations')).rows[0].n).toBe(before);
  });

  test('reviewing one → 409 with either outcome; nothing changes, nothing is assigned', async () => {
    const id = (await asTeacher({ studentId: a.student.id, ...praise })).body.observation.id;
    const before = await dbObservation(id);
    for (const body of [{ outcome: 'no_action' }, { outcome: 'assigned', activityIds: [activityA], developmentArea: 'communication' }]) {
      const r = await review(id, body);
      expect(r.status).toBe(409);
      expect(r.body.error).toEqual({ code: 'CONFLICT', message: 'Positive observations are celebrated, not reviewed.' });
    }
    expect(await dbObservation(id)).toEqual(before);
    expect(await assignmentsFor(id)).toHaveLength(0);
  });

  test('the queue: Pending and Reviewed never hold one; `tone` filters', async () => {
    const id = (await asParent({ studentId: a.student.id, ...praise })).body.observation.id;
    const q = async (qs: string) =>
      (await ctx.get(`${OBS}?limit=100&${qs}`, psych.token)).body.observations.map((o: { id: string }) => o.id) as string[];
    expect(await q('status=pending')).not.toContain(id);
    expect(await q('status=reviewed')).not.toContain(id);
    expect(await q('tone=concern')).not.toContain(id);
    expect(await q('tone=positive')).toContain(id);
    expect(await q('authorRole=parent&tone=positive')).toContain(id);
    const item = (await ctx.get(`${OBS}?limit=100&tone=positive`, psych.token)).body.observations.find((o: { id: string }) => o.id === id);
    expect(item).toMatchObject({ tone: 'positive', status: 'celebrated', review: null, author: { role: 'parent' } });
    expect((await ctx.get(`${OBS}?tone=happy`, psych.token)).status).toBe(400);
  });

  test('the database refuses a star in the review states, or a Level on one', async () => {
    const star = (await asTeacher({ studentId: a.student.id, ...praise })).body.observation.id;
    const concern = await teacherObservation();
    for (const [sql, id] of [
      [`UPDATE observations SET status = 'pending' WHERE id = $1`, star],
      [`UPDATE observations SET level = 'significant' WHERE id = $1`, star],
      [`UPDATE observations SET status = 'celebrated' WHERE id = $1`, concern],
      [`UPDATE observations SET tone = 'positive' WHERE id = $1`, concern],
    ] as const) {
      await expect(ctx.pg.query(sql, [id]), sql).rejects.toThrow(/check constraint/);
    }
  });
});

// ─────────────────────────────── Atomicity ───────────────────────────────
describe('review transaction is atomic', () => {
  // Failures are injected with triggers so they happen INSIDE the transaction, after earlier
  // steps have already written.
  test('marking reviewed fails after the assignments were inserted → the assignments roll back', async () => {
    const id = await teacherObservation();
    await ctx.pg.query(`
      CREATE OR REPLACE FUNCTION test_fail_review() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'reviewed' AND NEW.id = '${id}' THEN RAISE EXCEPTION 'injected failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await ctx.pg.query('CREATE TRIGGER test_fail_review BEFORE UPDATE ON observations FOR EACH ROW EXECUTE FUNCTION test_fail_review()');
    try {
      const r = await review(id, { outcome: 'assigned', activityIds: [activityA, activityB], developmentArea: 'confidence' });
      expect(r.status).toBe(500);
      expect(r.body.error.code).toBe('INTERNAL_ERROR');
    } finally {
      await ctx.pg.query('DROP TRIGGER test_fail_review ON observations');
      await ctx.pg.query('DROP FUNCTION test_fail_review()');
    }
    expect(await assignmentsFor(id)).toHaveLength(0);
    expect((await dbObservation(id))).toMatchObject({ status: 'pending', reviewed_by_id: null, development_area: null });
    // And the observation can still be reviewed normally afterwards.
    expect((await review(id, { outcome: 'assigned', activityIds: [activityA], developmentArea: 'confidence' })).status).toBe(200);
    expect(await assignmentsFor(id)).toHaveLength(1);
  });

  test('the second assignment fails → the first rolls back and the observation is not reviewed', async () => {
    const id = await teacherObservation();
    await ctx.pg.query(`
      CREATE OR REPLACE FUNCTION test_fail_assignment() RETURNS trigger AS $$
      BEGIN
        IF NEW.activity_id = '${activityB}' THEN RAISE EXCEPTION 'injected failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await ctx.pg.query('CREATE TRIGGER test_fail_assignment BEFORE INSERT ON assignments FOR EACH ROW EXECUTE FUNCTION test_fail_assignment()');
    try {
      expect((await review(id, { outcome: 'assigned', activityIds: [activityA, activityB], developmentArea: 'confidence' })).status).toBe(500);
    } finally {
      await ctx.pg.query('DROP TRIGGER test_fail_assignment ON assignments');
      await ctx.pg.query('DROP FUNCTION test_fail_assignment()');
    }
    expect(await assignmentsFor(id)).toHaveLength(0);
    expect((await dbObservation(id)).status).toBe('pending');
  });
});

// ─────────────────────────────── Teacher scope after class changes ───────────────────────────────
describe('teacher scope follows class membership', () => {
  test('a student moved out of the class can no longer be observed by the teacher', async () => {
    const kid = await newAccount(ctx, rootToken, 'student', SCHOOL_A);
    await addStudentToClass(ctx, a, kid.id);
    expect((await asTeacher({ studentId: kid.id, ...base })).status).toBe(201);
    expect((await ctx.del(`/api/v1/classes/${a.classId}/students/${kid.id}`, a.schoolAdmin.token)).status).toBe(204);
    expect((await asTeacher({ studentId: kid.id, ...base })).status).toBe(422);
  });
});
