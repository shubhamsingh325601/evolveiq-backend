// The notice board — Supertest over HTTP against the real app + PostgreSQL.
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

const NOTICES = '/api/v1/notices';
const post = (body: unknown, token: string) => ctx.post(NOTICES, body, token);
const titles = async (token: string, query = '') =>
  ((await ctx.get(`${NOTICES}${query}`, token)).body.notices as { title: string }[]).map((n) => n.title);

describe('posting and reading', () => {
  test('a school admin posts for their school, and each person sees their audience', async () => {
    const event = await post({ category: 'event', title: 'Sports day', startsOn: '2026-11-14', location: 'Main ground' }, a.schoolAdmin.token);
    expect(event.status).toBe(201);
    expect(event.body.notice).toMatchObject({
      schoolId: SCHOOL_A,
      category: 'event',
      startsOn: '2026-11-14',
      audience: 'everyone',
      isPinned: false,
      canManage: true,
    });
    expect((await post({ category: 'training', title: 'First-aid training', audience: 'staff' }, a.schoolAdmin.token)).status).toBe(201);
    expect((await post({ category: 'policy', title: 'Uniform policy', audience: 'families' }, a.schoolAdmin.token)).status).toBe(201);

    expect(await titles(a.teacher.token)).toEqual(expect.arrayContaining(['Sports day', 'First-aid training']));
    expect(await titles(a.teacher.token)).not.toContain('Uniform policy');
    for (const token of [a.parent.token, a.student.token]) {
      expect(await titles(token)).toEqual(expect.arrayContaining(['Sports day', 'Uniform policy']));
      expect(await titles(token)).not.toContain('First-aid training');
    }
    expect(await titles(a.schoolAdmin.token)).toEqual(expect.arrayContaining(['Sports day', 'First-aid training', 'Uniform policy']));
    expect(await titles(b.parent.token)).toEqual([]);
    expect(await titles(psych.token)).toEqual(expect.arrayContaining(['Sports day', 'First-aid training']));
    expect(await titles(psych.token)).not.toContain('Uniform policy');

    const asTeacher = (await ctx.get(NOTICES, a.teacher.token)).body.notices[0];
    expect(asTeacher.canManage).toBe(false);
  });

  test('a platform admin posts for every school, which school admins read but cannot change', async () => {
    const r = await post({ category: 'policy', title: 'Fire-drill guidance', body: 'Two drills a term.' }, rootToken);
    expect(r.status).toBe(201);
    expect(r.body.notice).toMatchObject({ schoolId: null, schoolName: null, canManage: true });
    expect(await titles(b.parent.token)).toContain('Fire-drill guidance');
    expect(await titles(a.teacher.token)).toContain('Fire-drill guidance');
    const seenByAdmin = ((await ctx.get(NOTICES, a.schoolAdmin.token)).body.notices as { id: string; canManage: boolean }[]).find(
      (n) => n.id === r.body.notice.id,
    );
    expect(seenByAdmin?.canManage).toBe(false);
    expect((await ctx.patch(`${NOTICES}/${r.body.notice.id}`, { title: 'Mine now' }, a.schoolAdmin.token)).status).toBe(404);
  });

  test('a platform admin can post for one school', async () => {
    const r = await post({ category: 'general', title: 'Welcome, Halden', schoolId: SCHOOL_B }, rootToken);
    expect(r.status).toBe(201);
    expect(r.body.notice.schoolName).toEqual(expect.any(String));
    expect(await titles(b.parent.token)).toContain('Welcome, Halden');
    expect(await titles(a.parent.token)).not.toContain('Welcome, Halden');
    const unknown = await post({ category: 'general', title: 'Nowhere', schoolId: '99999999-9999-4999-8999-999999999999' }, rootToken);
    expect(unknown.status).toBe(422);
  });
});

describe('rules', () => {
  test('an emergency contact needs a phone number', async () => {
    expect((await post({ category: 'emergency_contact', title: 'Ambulance' }, a.schoolAdmin.token)).status).toBe(400);
    const r = await post({ category: 'emergency_contact', title: 'Ambulance', phone: '108' }, a.schoolAdmin.token);
    expect(r.status).toBe(201);
    expect(r.body.notice.phone).toBe('108');
    expect((await ctx.patch(`${NOTICES}/${r.body.notice.id}`, { phone: null }, a.schoolAdmin.token)).status).toBe(400);
  });

  test('only admins post, and a school admin only for their own school', async () => {
    expect((await post({ category: 'event', title: 'x' }, a.teacher.token)).status).toBe(403);
    expect((await post({ category: 'event', title: 'x' }, a.parent.token)).status).toBe(403);
    expect((await post({ category: 'event', title: 'x', schoolId: SCHOOL_B }, a.schoolAdmin.token)).status).toBe(403);
    expect((await post({ category: 'event', title: '   ' }, a.schoolAdmin.token)).status).toBe(400);
    expect((await post({ category: 'party', title: 'x' }, a.schoolAdmin.token)).status).toBe(400);
  });

  test('a notice is edited, pinned and taken down by whoever may manage it', async () => {
    const created = (await post({ category: 'activity', title: 'Chess club' }, a.schoolAdmin.token)).body.notice;
    const path = `${NOTICES}/${created.id}`;
    expect((await ctx.patch(path, { isPinned: true }, b.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.patch(path, { isPinned: true }, a.teacher.token)).status).toBe(403);

    const edited = await ctx.patch(path, { isPinned: true, body: 'Thursdays after lunch', startsOn: '2026-11-12' }, a.schoolAdmin.token);
    expect(edited.status).toBe(200);
    expect(edited.body.notice).toMatchObject({ isPinned: true, body: 'Thursdays after lunch', startsOn: '2026-11-12' });
    expect((await titles(a.parent.token))[0]).toBe('Chess club');
    expect((await ctx.patch(path, { body: null }, a.schoolAdmin.token)).body.notice.body).toBeNull();
    expect((await ctx.patch(path, {}, a.schoolAdmin.token)).status).toBe(400);

    expect((await ctx.del(path, b.schoolAdmin.token)).status).toBe(404);
    expect((await ctx.del(path, a.schoolAdmin.token)).status).toBe(204);
    expect(await titles(a.parent.token)).not.toContain('Chess club');
    expect((await ctx.del(path, rootToken)).status).toBe(404);
  });

  test('filters by category; only platform admins filter by school', async () => {
    const events = (await ctx.get(`${NOTICES}?category=event`, a.parent.token)).body.notices as { category: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((n) => n.category === 'event')).toBe(true);
    expect((await ctx.get(`${NOTICES}?schoolId=${SCHOOL_A}`, a.schoolAdmin.token)).status).toBe(403);
    const onlyB = (await ctx.get(`${NOTICES}?schoolId=${SCHOOL_B}`, rootToken)).body.notices as { schoolId: string }[];
    expect(onlyB.every((n) => n.schoolId === SCHOOL_B)).toBe(true);
  });
});
