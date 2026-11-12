// Parent <-> school messages — Supertest over HTTP against the real app + PostgreSQL.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, SCHOOL_A, SCHOOL_B, createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { createSchoolFixture, newAccount, type Account, type SchoolFixture } from '../../../test/support/fixtures.js';

let ctx: TestContext;
let a: SchoolFixture;
let b: SchoolFixture;
let psych: Account;

beforeAll(async () => {
  ctx = await createTestContext();
  const rootToken = (await ctx.login(ADMIN)).body.accessToken;
  a = await createSchoolFixture(ctx, rootToken, SCHOOL_A);
  b = await createSchoolFixture(ctx, rootToken, SCHOOL_B);
  psych = await newAccount(ctx, rootToken, 'psychologist');
});

afterAll(async () => {
  await ctx?.close();
});

const contactsUrl = (f: SchoolFixture) => `/api/v1/students/${f.student.id}/contacts`;
const messagesUrl = (f: SchoolFixture) => `/api/v1/students/${f.student.id}/messages`;
const write = (f: SchoolFixture, contactId: string, body: string, token = f.parent.token) =>
  ctx.post(messagesUrl(f), { contactId, body }, token);

describe('contacts', () => {
  test('lists the class teacher, the school admin and the counsellors, by name and role only', async () => {
    const r = await ctx.get(contactsUrl(a), a.parent.token);
    expect(r.status).toBe(200);
    const ids = r.body.contacts.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([a.teacher.id, a.schoolAdmin.id, psych.id]));
    expect(ids).not.toContain(b.teacher.id);
    expect(Object.keys(r.body.contacts[0]).sort()).toEqual(['fullName', 'id', 'role']);
  });

  test('are for parents of that child only', async () => {
    expect((await ctx.get(contactsUrl(a), a.student.token)).status).toBe(403);
    expect((await ctx.get(contactsUrl(a), a.teacher.token)).status).toBe(403);
    expect((await ctx.get(contactsUrl(a), b.parent.token)).status).toBe(404);
    expect((await ctx.get(contactsUrl(a))).status).toBe(401);
  });
});

describe('a conversation', () => {
  test('a parent writes to the class teacher, who sees it in the inbox and replies', async () => {
    const sent = await write(a, a.teacher.id, '  Is Maya settling in well?  ');
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ body: 'Is Maya settling in well?', fromParent: true });

    const inbox = await ctx.get('/api/v1/messages', a.teacher.token);
    expect(inbox.status).toBe(200);
    expect(inbox.body.unreadCount).toBe(1);
    expect(inbox.body.threads[0]).toMatchObject({ studentId: a.student.id, unreadCount: 1 });

    const opened = await ctx.get(`/api/v1/messages/${a.student.id}`, a.teacher.token);
    expect(opened.status).toBe(200);
    expect(opened.body.messages).toHaveLength(1);
    expect((await ctx.get('/api/v1/messages', a.teacher.token)).body.unreadCount).toBe(0);

    const reply = await ctx.post(`/api/v1/messages/${a.student.id}`, { body: 'Very well. She joined the reading group.' }, a.teacher.token);
    expect(reply.status).toBe(201);
    expect(reply.body.message.fromParent).toBe(false);

    const thread = await ctx.get(`${messagesUrl(a)}?contactId=${a.teacher.id}`, a.parent.token);
    expect(thread.body.messages.map((m: { fromParent: boolean }) => m.fromParent)).toEqual([true, false]);
    expect(thread.body.contact.id).toBe(a.teacher.id);
  });

  test('threads with different contacts stay apart', async () => {
    await write(a, a.schoolAdmin.id, 'Where do I send the fee receipt?');
    const withTeacher = await ctx.get(`${messagesUrl(a)}?contactId=${a.teacher.id}`, a.parent.token);
    const withAdmin = await ctx.get(`${messagesUrl(a)}?contactId=${a.schoolAdmin.id}`, a.parent.token);
    expect(withTeacher.body.messages).toHaveLength(2);
    expect(withAdmin.body.messages).toHaveLength(1);
  });

  test('refuses someone who is not a contact for this child, and bad bodies', async () => {
    expect((await write(a, b.teacher.id, 'Hello')).status).toBe(422);
    expect((await write(a, a.student.id, 'Hello')).status).toBe(422);
    expect((await write(a, a.teacher.id, '   ')).status).toBe(400);
    expect((await write(a, a.teacher.id, 'x'.repeat(1001))).status).toBe(400);
    expect((await ctx.get(`${messagesUrl(a)}?contactId=${b.teacher.id}`, a.parent.token)).status).toBe(404);
  });

  test('only a parent starts a thread, and only their own child’s', async () => {
    expect((await write(a, a.teacher.id, 'Hi', a.student.token)).status).toBe(403);
    expect((await write(a, a.teacher.id, 'Hi', a.teacher.token)).status).toBe(403);
    expect((await write(a, a.teacher.id, 'Hi', b.parent.token)).status).toBe(404);
  });
});

describe('the staff side', () => {
  test('staff cannot start a thread, and see only their own', async () => {
    const reply = await ctx.post(`/api/v1/messages/${a.student.id}`, { body: 'Hello' }, psych.token);
    expect(reply.status).toBe(404);
    expect((await ctx.get(`/api/v1/messages/${a.student.id}`, psych.token)).status).toBe(404);
    expect((await ctx.get('/api/v1/messages', psych.token)).body.threads).toEqual([]);
  });

  test('a counsellor replies once a parent has written to them', async () => {
    expect((await write(a, psych.id, 'We would like some advice on screen time.')).status).toBe(201);
    expect((await ctx.post(`/api/v1/messages/${a.student.id}`, { body: 'Happy to talk, shall we set up a time?' }, psych.token)).status).toBe(201);
  });

  test('another school’s teacher reaches nothing (404), and students and parents are refused', async () => {
    expect((await ctx.get(`/api/v1/messages/${a.student.id}`, b.teacher.token)).status).toBe(404);
    expect((await ctx.get('/api/v1/messages', a.parent.token)).status).toBe(403);
    expect((await ctx.get('/api/v1/messages', a.student.token)).status).toBe(403);
    expect((await ctx.get('/api/v1/messages')).status).toBe(401);
  });
});
