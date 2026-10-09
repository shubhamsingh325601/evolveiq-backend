// Timezone regression: the Prisma pg adapter assumes a UTC session (it writes DateTime values
// as UTC wall-clock time without an offset and rewrites the offset of every timestamptz it
// reads to +00:00). The test database deliberately defaults to a non-UTC zone
// (test/support/global-setup.ts), so these fail if createPrismaClient stops pinning UTC.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/support/api-harness.js';
import { TEST_SERVER_TIMEZONE } from '../../../test/support/global-setup.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx?.close();
});

const TOLERANCE_MS = 5_000;

describe('createPrismaClient — session timezone', () => {
  test('the test server really defaults to a non-UTC zone (otherwise these tests prove nothing)', async () => {
    const { rows } = await ctx.pg.query('SHOW TimeZone');
    expect(rows[0].TimeZone).toBe(TEST_SERVER_TIMEZONE);
  });

  test('Prisma sessions run in UTC regardless of the server default', async () => {
    const rows = await ctx.prisma.$queryRaw<{ TimeZone: string }[]>`SHOW TimeZone`;
    expect(rows[0]?.TimeZone).toBe('UTC');
  });

  test('a database-generated timestamp (DEFAULT now()) reads back as the real instant', async () => {
    const before = Date.now();
    const school = await ctx.prisma.school.create({ data: { name: 'TZ Probe' } });
    expect(Math.abs(school.createdAt.getTime() - before)).toBeLessThan(TOLERANCE_MS);
  });

  test('a client-supplied Date is stored as that instant (checked through a non-Prisma connection)', async () => {
    const instant = new Date('2026-03-31T18:45:00.000Z'); // 00:15 on 1 April in IST
    const school = await ctx.prisma.school.create({ data: { name: 'TZ Write', createdAt: instant } });
    const { rows } = await ctx.pg.query(
      'SELECT extract(epoch FROM created_at)::bigint AS epoch FROM schools WHERE id = $1', [school.id]);
    expect(Number(rows[0].epoch) * 1000).toBe(instant.getTime());
    const reread = await ctx.prisma.school.findUniqueOrThrow({ where: { id: school.id } });
    expect(reread.createdAt.toISOString()).toBe(instant.toISOString());
  });

  test('raw queries agree with the database clock', async () => {
    const rows = await ctx.prisma.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    expect(Math.abs(rows[0]!.now.getTime() - Date.now())).toBeLessThan(TOLERANCE_MS);
  });
});
