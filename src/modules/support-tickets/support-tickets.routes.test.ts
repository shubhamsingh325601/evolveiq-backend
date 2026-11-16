// The IT Help Desk — Supertest over HTTP against the real app + PostgreSQL. A gap found against
// the client's UI prototype (16 Nov 2026), not yet a confirmed client request.
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

const TICKETS = '/api/v1/support-tickets';
const raise = (body: unknown, token: string) => ctx.post(TICKETS, body, token);
const subjects = async (token: string, query = '') =>
  ((await ctx.get(`${TICKETS}${query}`, token)).body.tickets as { subject: string }[]).map((t) => t.subject);

describe('raising and reading', () => {
  test('a teacher raises a ticket, starting open and scoped to their school', async () => {
    const r = await raise({ subject: 'Projector not turning on', body: 'Room 4, bulb may be dead.' }, a.teacher.token);
    expect(r.status).toBe(201);
    expect(r.body.ticket).toMatchObject({
      schoolId: SCHOOL_A,
      subject: 'Projector not turning on',
      body: 'Room 4, bulb may be dead.',
      status: 'open',
      canManage: false,
    });
    expect(r.body.ticket.raisedBy.fullName).toEqual(expect.any(String));
  });

  test('a teacher sees only their own tickets; a school admin sees the whole school', async () => {
    await raise({ subject: 'Wifi down in the staff room' }, a.schoolAdmin.token);
    const otherTeacher = await newAccount(ctx, rootToken, 'teacher', SCHOOL_A);
    await raise({ subject: 'Printer out of toner' }, otherTeacher.token);

    expect(await subjects(a.teacher.token)).toEqual(['Projector not turning on']);
    expect(await subjects(otherTeacher.token)).toEqual(['Printer out of toner']);
    expect(await subjects(a.schoolAdmin.token)).toEqual(
      expect.arrayContaining(['Projector not turning on', 'Wifi down in the staff room', 'Printer out of toner']),
    );
    const asAdmin = (await ctx.get(TICKETS, a.schoolAdmin.token)).body.tickets[0];
    expect(asAdmin.canManage).toBe(true);
  });

  test('a psychologist (no school) is forbidden from raising a ticket', async () => {
    expect((await raise({ subject: 'Cannot log in to the portal' }, psych.token)).status).toBe(403);
  });

  test('only teachers, psychologists and school admins raise tickets, and a blank subject is rejected', async () => {
    expect((await raise({ subject: 'x' }, a.parent.token)).status).toBe(403);
    expect((await raise({ subject: 'x' }, a.student.token)).status).toBe(403);
    expect((await raise({ subject: '   ' }, a.teacher.token)).status).toBe(400);
    expect((await raise({ subject: 'x'.repeat(121) }, a.teacher.token)).status).toBe(400);
    expect((await raise({ subject: 'x', schoolId: SCHOOL_B }, a.teacher.token)).status).toBe(400); // schoolId is not accepted in the body
  });

  test('cross-school isolation: a school admin never sees another school’s tickets', async () => {
    expect(await subjects(b.schoolAdmin.token)).toEqual([]);
  });
});

describe('status changes', () => {
  test('a school admin moves a ticket raised in their school through its states', async () => {
    const created = (await raise({ subject: 'Laptop cart locked' }, a.teacher.token)).body.ticket;
    const path = `${TICKETS}/${created.id}`;
    const inProgress = await ctx.patch(path, { status: 'in_progress' }, a.schoolAdmin.token);
    expect(inProgress.status).toBe(200);
    expect(inProgress.body.ticket.status).toBe('in_progress');
    const resolved = await ctx.patch(path, { status: 'resolved' }, a.schoolAdmin.token);
    expect(resolved.status).toBe(200);
    expect(resolved.body.ticket.status).toBe('resolved');
  });

  test('a teacher cannot change status, even on their own ticket (403)', async () => {
    const created = (await raise({ subject: 'Monitor flickering' }, a.teacher.token)).body.ticket;
    expect((await ctx.patch(`${TICKETS}/${created.id}`, { status: 'resolved' }, a.teacher.token)).status).toBe(403);
    expect((await ctx.patch(`${TICKETS}/${created.id}`, { status: 'resolved' }, psych.token)).status).toBe(403);
  });

  test('a ticket outside the caller’s school is 404, not a leak', async () => {
    const created = (await raise({ subject: 'Door lock jammed' }, a.teacher.token)).body.ticket;
    expect((await ctx.patch(`${TICKETS}/${created.id}`, { status: 'resolved' }, b.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.patch(`${TICKETS}/00000000-0000-4000-8000-000000000000`, { status: 'resolved' }, a.schoolAdmin.token)).status).toBe(
      404,
    );
  });
});

describe('platform admin', () => {
  test('sees every school’s tickets, can filter by schoolId, and can change status anywhere', async () => {
    const bTicket = (await raise({ subject: 'Door card reader offline' }, b.teacher.token)).body.ticket;

    const all = await subjects(rootToken);
    expect(all).toEqual(expect.arrayContaining(['Projector not turning on', 'Door card reader offline']));

    const onlyB = (await ctx.get(`${TICKETS}?schoolId=${SCHOOL_B}`, rootToken)).body.tickets as { schoolId: string }[];
    expect(onlyB.length).toBeGreaterThan(0);
    expect(onlyB.every((t) => t.schoolId === SCHOOL_B)).toBe(true);

    expect((await ctx.get(`${TICKETS}?schoolId=${SCHOOL_A}`, a.schoolAdmin.token)).status).toBe(403);

    const resolved = await ctx.patch(`${TICKETS}/${bTicket.id}`, { status: 'resolved' }, rootToken);
    expect(resolved.status).toBe(200);
    expect(resolved.body.ticket.status).toBe('resolved');
  });
});
