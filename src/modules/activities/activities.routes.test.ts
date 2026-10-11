// Activities, assignments and completions — Supertest over HTTP against the real app + PostgreSQL.
// The five types through one discriminated union, psychologist-only authoring, archive (never
// delete), type/options frozen once assigned, teacher direct assignment within their classes,
// student-only completion (own assignment, matching answer, once), and who sees answers.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import {
  IMAGE_PICK,
  MCQ,
  MEDIA,
  RATING,
  TEXT,
  createActivity,
  createSchoolFixture,
  newAccount,
  type Account,
  type SchoolFixture,
} from '../../../test/support/fixtures.js';

const ACT = '/api/v1/activities';
const ASSIGN = '/api/v1/assignments';
const COMPLETE = '/api/v1/activity-completions';

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

const create = (content: unknown, token = psych.token, title: unknown = 'An activity') => ctx.post(ACT, { title, content }, token);
const assign = (studentId: string, activityId: string, token = a.teacher.token) => ctx.post(ASSIGN, { studentId, activityId }, token);
const complete = (assignmentId: string, answer: unknown, token = a.student.token) => ctx.post(COMPLETE, { assignmentId, answer }, token);
const newAssignment = async (content: Record<string, unknown> = MCQ, f: SchoolFixture = a) => {
  const activityId = await createActivity(ctx, psych.token, content);
  const r = await assign(f.student.id, activityId, f.teacher.token);
  if (r.status !== 201) throw new Error(`assign failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { activityId, assignmentId: r.body.assignment.id as string };
};

// ─────────────────────────────── Library ───────────────────────────────
describe('library — the five types through one discriminated union', () => {
  test.each([['mcq', MCQ], ['text', TEXT], ['image_pick', IMAGE_PICK], ['rating', RATING], ['media_response', MEDIA]])(
    'creates %s and returns its content unchanged',
    async (_type, content) => {
      const r = await create(content);
      expect(r.status).toBe(201);
      expect(r.body.activity).toMatchObject({ title: 'An activity', content, isArchived: false, isAssigned: false });
      expect(r.headers.location).toBe(`${ACT}/${r.body.activity.id}`);
      const row = (await ctx.pg.query('SELECT type, content FROM activities WHERE id = $1', [r.body.activity.id])).rows[0];
      expect(row.type).toBe(content.type);
      expect(row.content).not.toHaveProperty('type');
    },
  );

  test.each([
    ['unknown type', { type: 'essay', prompt: 'x' }],
    ['missing type', { prompt: 'x' }],
    ['mcq without options', { type: 'mcq', prompt: 'x' }],
    ['mcq with one option', { type: 'mcq', prompt: 'x', options: [{ id: 'a', label: 'A' }] }],
    ['mcq with 7 options', { type: 'mcq', prompt: 'x', options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })) }],
    ['mcq duplicate option ids', { type: 'mcq', prompt: 'x', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }],
    ['mcq bad option id', { type: 'mcq', prompt: 'x', options: [{ id: 'a b', label: 'A' }, { id: 'c', label: 'C' }] }],
    ['mcq with a correct answer', { ...MCQ, correctOptionId: 'happy' }],
    ['text with options', { ...TEXT, options: MCQ.options }],
    ['image_pick without URLs', { type: 'image_pick', prompt: 'x', options: [{ id: 'a' }, { id: 'b' }] }],
    ['image_pick non-http URL', { ...IMAGE_PICK, options: [{ id: 'a', imageUrl: 'javascript:alert(1)' }, { id: 'b', imageUrl: 'ftp://x.test/b.png' }] }],
    ['rating with a scale', { ...RATING, max: 10 }],
    ['media without URL', { type: 'media_response', prompt: 'x' }],
    ['media with an upload', { ...MEDIA, file: 'base64...' }],
    ['blank prompt', { type: 'text', prompt: '   ' }],
  ])('%s → 400', async (_label, content) => {
    const r = await create(content);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('blank or missing title → 400', async () => {
    expect((await create(TEXT, psych.token, '  ')).status).toBe(400);
    expect((await ctx.post(ACT, { content: TEXT }, psych.token)).status).toBe(400);
  });

  test('only psychologists write; teachers browse; others are refused', async () => {
    for (const who of [a.teacher, a.schoolAdmin, a.parent, a.student]) expect((await create(TEXT, who.token)).status).toBe(403);
    expect((await create(TEXT, rootToken)).status).toBe(403);
    const id = await createActivity(ctx, psych.token, TEXT);
    expect((await ctx.patch(`${ACT}/${id}`, { title: 'X' }, a.teacher.token)).status).toBe(403);
    expect((await ctx.post(`${ACT}/${id}/archive`, undefined, a.teacher.token)).status).toBe(403);
    expect((await ctx.get(`${ACT}/${id}`, a.teacher.token)).status).toBe(200);
    expect((await ctx.get(ACT, a.teacher.token)).status).toBe(200);
    for (const who of [a.schoolAdmin, a.parent, a.student]) expect((await ctx.get(ACT, who.token)).status).toBe(403);
  });

  test('one global library: a teacher of any school browses the same activities', async () => {
    const id = await createActivity(ctx, psych.token, TEXT, 'Global one');
    for (const t of [a.teacher, b.teacher]) {
      const r = await ctx.get(`${ACT}?limit=100&title=global one`, t.token);
      expect(r.body.activities.map((x: { id: string }) => x.id)).toContain(id);
    }
  });

  test('edit title and content while unassigned', async () => {
    const id = await createActivity(ctx, psych.token, MCQ);
    const changed = { ...MCQ, options: [...MCQ.options, { id: 'ok', label: 'Okay' }] };
    const r = await ctx.patch(`${ACT}/${id}`, { title: 'Renamed', content: changed }, psych.token);
    expect(r.status).toBe(200);
    expect(r.body.activity).toMatchObject({ title: 'Renamed', content: changed });
    const toText = await ctx.patch(`${ACT}/${id}`, { content: TEXT }, psych.token);
    expect(toText.status).toBe(200);
    expect(toText.body.activity.content).toEqual(TEXT);
  });

  test('edit: empty body or invalid content → 400; unknown → 404', async () => {
    const id = await createActivity(ctx, psych.token, TEXT);
    expect((await ctx.patch(`${ACT}/${id}`, {}, psych.token)).status).toBe(400);
    expect((await ctx.patch(`${ACT}/${id}`, { content: { type: 'mcq', prompt: 'x' } }, psych.token)).status).toBe(400);
    expect((await ctx.patch(`${ACT}/99999999-9999-4999-8999-999999999999`, { title: 'X' }, psych.token)).status).toBe(404);
  });
});

describe('archive (never delete)', () => {
  test('archives idempotently; hidden from teachers, listed for psychologists with isArchived=true', async () => {
    const id = await createActivity(ctx, psych.token, TEXT, 'Archive me');
    const r = await ctx.post(`${ACT}/${id}/archive`, undefined, psych.token);
    expect(r.status).toBe(200);
    expect(r.body.activity.isArchived).toBe(true);
    const archivedAt = (await ctx.pg.query('SELECT archived_at FROM activities WHERE id = $1', [id])).rows[0].archived_at;
    expect((await ctx.post(`${ACT}/${id}/archive`, undefined, psych.token)).status).toBe(200);
    expect((await ctx.pg.query('SELECT archived_at FROM activities WHERE id = $1', [id])).rows[0].archived_at).toEqual(archivedAt);

    expect((await ctx.get(`${ACT}/${id}`, a.teacher.token)).status).toBe(404);
    expect((await ctx.get(`${ACT}?limit=100`, a.teacher.token)).body.activities.map((x: { id: string }) => x.id)).not.toContain(id);
    expect((await ctx.get(`${ACT}?isArchived=true`, a.teacher.token)).status).toBe(403);
    expect((await ctx.get(`${ACT}?isArchived=true&limit=100`, psych.token)).body.activities.map((x: { id: string }) => x.id)).toContain(id);
    expect((await ctx.get(`${ACT}/${id}`, psych.token)).status).toBe(200);
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM activities WHERE id = $1', [id])).rows[0].n).toBe(1);
  });

  test('an archived activity cannot be assigned (422); existing assignments keep working', async () => {
    const { activityId, assignmentId } = await newAssignment(TEXT);
    await ctx.post(`${ACT}/${activityId}/archive`, undefined, psych.token);
    const r = await assign(a.student.id, activityId);
    expect(r.status).toBe(422);
    expect(r.body.error.details).toEqual({ field: 'activityId' });
    expect((await complete(assignmentId, { type: 'text', text: 'Still doable.' })).status).toBe(201);
  });

  test('there is no delete endpoint', async () => {
    const id = await createActivity(ctx, psych.token, TEXT);
    expect((await ctx.del(`${ACT}/${id}`, psych.token)).status).toBe(404);
  });
});

describe('type and options are frozen once assigned', () => {
  test('changing the type or the options → 409; nothing changes', async () => {
    const { activityId } = await newAssignment(MCQ);
    const before = (await ctx.pg.query('SELECT type, content, title FROM activities WHERE id = $1', [activityId])).rows[0];
    for (const content of [
      TEXT,
      { ...MCQ, options: [...MCQ.options, { id: 'meh', label: 'Meh' }] },
      { ...MCQ, options: [{ id: 'happy', label: 'Very happy' }, MCQ.options[1]] },
      { ...MCQ, options: [...MCQ.options].reverse() },
    ]) {
      const r = await ctx.patch(`${ACT}/${activityId}`, { title: 'Sneaky', content }, psych.token);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('CONFLICT');
    }
    expect((await ctx.pg.query('SELECT type, content, title FROM activities WHERE id = $1', [activityId])).rows[0]).toEqual(before);
  });

  test('the title and the prompt can still change', async () => {
    const { activityId } = await newAssignment(MCQ);
    const r = await ctx.patch(`${ACT}/${activityId}`, { title: 'Better title', content: { ...MCQ, prompt: 'How are you feeling right now?' } }, psych.token);
    expect(r.status).toBe(200);
    expect(r.body.activity).toMatchObject({ title: 'Better title', isAssigned: true, content: { prompt: 'How are you feeling right now?', options: MCQ.options } });
  });

  test('a recommended assignment (via review) freezes it too', async () => {
    const activityId = await createActivity(ctx, psych.token, IMAGE_PICK);
    const obs = await ctx.post('/api/v1/observations', { studentId: a.student.id, area: 'social', description: 'Plays alone.', when: 'today', howOften: 'often' }, a.teacher.token);
    expect((await ctx.post(`/api/v1/observations/${obs.body.observation.id}/review`, { outcome: 'assigned', activityIds: [activityId] }, psych.token)).status).toBe(200);
    expect((await ctx.patch(`${ACT}/${activityId}`, { content: RATING }, psych.token)).status).toBe(409);
  });
});

// ─────────────────────────────── Assignments ───────────────────────────────
describe('assignments', () => {
  test('a teacher assigns directly to a student of their class (source "direct")', async () => {
    const activityId = await createActivity(ctx, psych.token, RATING);
    const r = await assign(a.student.id, activityId);
    expect(r.status).toBe(201);
    expect(r.body.assignment).toMatchObject({
      studentId: a.student.id,
      activity: { id: activityId, type: 'rating' },
      source: 'direct',
      assignedBy: { id: a.teacher.id },
      observationId: null,
      completion: null,
    });
  });

  test("a teacher cannot assign to another teacher's student or another school's → 422, nothing written", async () => {
    const activityId = await createActivity(ctx, psych.token, TEXT);
    const colleague = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A); // no classes
    const noClass = await newAccount(ctx, rootToken, 'student', SCHOOL_A);
    const cases: [string, string][] = [[a.student.id, colleague.token], [b.student.id, a.teacher.token], [noClass.id, a.teacher.token], [a.parent.id, a.teacher.token]];
    for (const [studentId, token] of cases) {
      const r = await assign(studentId, activityId, token);
      expect(r.status).toBe(422);
      expect(r.body.error.details).toEqual({ field: 'studentId' });
    }
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM assignments WHERE activity_id = $1', [activityId])).rows[0].n).toBe(0);
  });

  test('psychologists cannot assign directly (only through a review) → 403', async () => {
    const activityId = await createActivity(ctx, psych.token, TEXT);
    expect((await assign(a.student.id, activityId, psych.token)).status).toBe(403);
    for (const who of [a.schoolAdmin, a.parent, a.student]) expect((await assign(a.student.id, activityId, who.token)).status).toBe(403);
  });

  test('unknown activity → 422; invalid body → 400', async () => {
    expect((await assign(a.student.id, '99999999-9999-4999-8999-999999999999')).status).toBe(422);
    expect((await ctx.post(ASSIGN, { studentId: a.student.id }, a.teacher.token)).status).toBe(400);
    expect((await ctx.post(ASSIGN, { studentId: a.student.id, activityId: a.student.id, dueDate: '2026-12-01' }, a.teacher.token)).status).toBe(400);
  });

  test("staff see a student's assignments with answers; teachers only for their own classes", async () => {
    const { assignmentId } = await newAssignment(TEXT);
    await complete(assignmentId, { type: 'text', text: 'I liked it.' });
    for (const token of [a.teacher.token, psych.token]) {
      const r = await ctx.get(`/api/v1/students/${a.student.id}/assignments?limit=100`, token);
      expect(r.status).toBe(200);
      const item = r.body.assignments.find((x: { id: string }) => x.id === assignmentId);
      expect(item.completion.answer).toEqual({ type: 'text', text: 'I liked it.' });
    }
    expect((await ctx.get(`/api/v1/students/${a.student.id}/assignments`, b.teacher.token)).status).toBe(404);
    const colleague = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
    expect((await ctx.get(`/api/v1/students/${a.student.id}/assignments`, colleague.token)).status).toBe(404);
    for (const who of [a.parent, a.student, a.schoolAdmin]) {
      expect((await ctx.get(`/api/v1/students/${a.student.id}/assignments`, who.token)).status).toBe(403);
    }
  });
});

// ─────────────────────────────── Completion ───────────────────────────────
describe('student completion', () => {
  test.each([
    ['mcq', MCQ, { type: 'mcq', optionId: 'sad' }],
    ['text', TEXT, { type: 'text', text: 'We went to the park.' }],
    ['image_pick', IMAGE_PICK, { type: 'image_pick', optionId: 'lake' }],
    ['rating', RATING, { type: 'rating', rating: 4 }],
    ['media_response', MEDIA, { type: 'media_response', text: 'The bird was blue.' }],
  ])('%s: a valid answer → 201, stored as given', async (_type, content, answer) => {
    const { assignmentId } = await newAssignment(content);
    const r = await complete(assignmentId, answer);
    expect(r.status).toBe(201);
    expect(r.body.completion).toMatchObject({ assignmentId, answer });
    const row = (await ctx.pg.query('SELECT response FROM activity_completions WHERE assignment_id = $1', [assignmentId])).rows[0];
    expect(row.response).toEqual(answer);
  });

  test.each([
    ['mcq', MCQ, { type: 'mcq', optionId: 'angry' }, 'answer.optionId'],
    ['image_pick', IMAGE_PICK, { type: 'image_pick', optionId: 'desert' }, 'answer.optionId'],
    ['mcq answered as text', MCQ, { type: 'text', text: 'Happy' }, 'answer.type'],
    ['rating answered as mcq', RATING, { type: 'mcq', optionId: 'happy' }, 'answer.type'],
  ])('%s: answer not valid for the activity → 400 (%s), nothing stored', async (_label, content, answer, field) => {
    const { assignmentId } = await newAssignment(content);
    const r = await complete(assignmentId, answer);
    expect(r.status).toBe(400);
    expect(r.body.error.details.map((d: { field: string }) => d.field)).toEqual([field]);
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM activity_completions WHERE assignment_id = $1', [assignmentId])).rows[0].n).toBe(0);
  });

  test.each([
    ['rating 0', { type: 'rating', rating: 0 }],
    ['rating 6', { type: 'rating', rating: 6 }],
    ['rating 3.5', { type: 'rating', rating: 3.5 }],
    ['rating as string', { type: 'rating', rating: '4' }],
    ['blank text', { type: 'text', text: '  ' }],
    ['text too long', { type: 'text', text: 'x'.repeat(2001) }],
    ['extra field', { type: 'rating', rating: 3, score: 100 }],
    ['unknown type', { type: 'essay', text: 'x' }],
  ])('%s → 400 from the answer union', async (_label, answer) => {
    const { assignmentId } = await newAssignment(RATING);
    expect((await complete(assignmentId, answer)).status).toBe(400);
  });

  test('one completion per assignment: a second answer → 409, the first stays', async () => {
    const { assignmentId } = await newAssignment(RATING);
    expect((await complete(assignmentId, { type: 'rating', rating: 2 })).status).toBe(201);
    const r = await complete(assignmentId, { type: 'rating', rating: 5 });
    expect(r.status).toBe(409);
    const rows = (await ctx.pg.query('SELECT response FROM activity_completions WHERE assignment_id = $1', [assignmentId])).rows;
    expect(rows).toEqual([{ response: { type: 'rating', rating: 2 } }]);
  });

  test('concurrent submissions: exactly one is stored', async () => {
    const { assignmentId } = await newAssignment(RATING);
    const results = await Promise.all([1, 2, 3, 4, 5].map((rating) => complete(assignmentId, { type: 'rating', rating })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  test("a student cannot submit for another student's assignment → 404, nothing stored", async () => {
    const { assignmentId } = await newAssignment(TEXT);
    const other = await newAccount(ctx, rootToken, 'student', SCHOOL_A);
    for (const token of [other.token, b.student.token]) {
      const r = await complete(assignmentId, { type: 'text', text: 'Not mine.' }, token);
      expect(r.status).toBe(404);
    }
    expect((await ctx.pg.query('SELECT count(*)::int AS n FROM activity_completions WHERE assignment_id = $1', [assignmentId])).rows[0].n).toBe(0);
  });

  test('only students submit', async () => {
    const { assignmentId } = await newAssignment(TEXT);
    for (const who of [a.teacher, a.parent, psych]) {
      expect((await complete(assignmentId, { type: 'text', text: 'x' }, who.token)).status).toBe(403);
    }
  });
});

// ─────────────────────────────── Who sees what ───────────────────────────────
describe('student and parent views', () => {
  test('a student sees only their own assignments, with the content to do and their own answer', async () => {
    const { assignmentId } = await newAssignment(MCQ);
    await complete(assignmentId, { type: 'mcq', optionId: 'happy' });
    const theirs = await newAssignment(TEXT, b);

    const r = await ctx.get('/api/v1/assignments/mine?limit=100', a.student.token);
    expect(r.status).toBe(200);
    const ids = r.body.assignments.map((x: { id: string }) => x.id);
    expect(ids).toContain(assignmentId);
    expect(ids).not.toContain(theirs.assignmentId);
    const { rows } = await ctx.pg.query('SELECT id FROM assignments WHERE student_id = $1', [a.student.id]);
    expect(ids.sort()).toEqual(rows.map((x: { id: string }) => x.id).sort());
    const item = r.body.assignments.find((x: { id: string }) => x.id === assignmentId);
    expect(Object.keys(item).sort()).toEqual(['activity', 'assignedAt', 'completion', 'id', 'isDone']);
    expect(item).toMatchObject({ isDone: true, activity: { content: MCQ }, completion: { answer: { type: 'mcq', optionId: 'happy' } } });
    expect((await ctx.get('/api/v1/assignments/mine?isDone=false&limit=100', a.student.token)).body.assignments.every((x: { isDone: boolean }) => !x.isDone)).toBe(true);
  });

  test("a parent sees their child's activities as done / not done — never the answers", async () => {
    const done = await newAssignment(TEXT);
    await complete(done.assignmentId, { type: 'text', text: 'Private diary entry.' });
    const todo = await newAssignment(RATING);

    const r = await ctx.get(`/api/v1/family/children/${a.student.id}/assignments?limit=100`, a.parent.token);
    expect(r.status).toBe(200);
    for (const item of r.body.assignments) expect(Object.keys(item).sort()).toEqual(['id', 'isDone', 'title']);
    const byId = Object.fromEntries(r.body.assignments.map((x: { id: string; isDone: boolean }) => [x.id, x.isDone]));
    expect(byId[done.assignmentId]).toBe(true);
    expect(byId[todo.assignmentId]).toBe(false);
    const raw = JSON.stringify(r.body);
    for (const secret of ['Private diary entry', 'answer', 'source', 'assignedBy', a.teacher.id, 'observationId']) expect(raw, secret).not.toContain(secret);
  });

  test("a parent cannot see another child's activities → 404", async () => {
    expect((await ctx.get(`/api/v1/family/children/${b.student.id}/assignments`, a.parent.token)).status).toBe(404);
    const notMine = await newAccount(ctx, rootToken, 'student', SCHOOL_A);
    expect((await ctx.get(`/api/v1/family/children/${notMine.id}/assignments`, a.parent.token)).status).toBe(404);
    for (const who of [a.teacher, a.student, psych]) {
      expect((await ctx.get(`/api/v1/family/children/${a.student.id}/assignments`, who.token)).status).toBe(403);
    }
  });
});
