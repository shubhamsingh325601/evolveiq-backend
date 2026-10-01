// Proves list filtering, sorting and pagination happen IN THE DATABASE: captures the SQL
// Prisma sends and checks for WHERE … ILIKE, ORDER BY and LIMIT/OFFSET.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';
import { createSchoolsRepository } from './schools.repository.js';
import { createTestContext, type TestContext } from '../../../test/support/api-harness.js';

let ctx: TestContext;
let prisma: PrismaClient<'query'>;
const queries: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL! }),
    log: [{ emit: 'event', level: 'query' }],
  });
  prisma.$on('query', (e) => queries.push(e.query));
});

afterAll(async () => {
  await prisma?.$disconnect();
  await ctx?.close();
});

describe('schools repository (database-level list)', () => {
  test('filter, sort and pagination are pushed down to PostgreSQL', async () => {
    const repo = createSchoolsRepository(prisma);
    queries.length = 0;
    const { items, total } = await repo.list({ skip: 1, take: 1, sortBy: 'name', sortOrder: 'desc', nameContains: 'demo' });
    expect(total).toBe(2);
    expect(items.map((s) => s.name)).toEqual(['Demo School A']); // 2nd of [B, A]

    const select = queries.find((q) => /SELECT/i.test(q) && /LIMIT/i.test(q));
    expect(select, queries.join('\n')).toBeDefined();
    expect(select).toMatch(/ILIKE/i);
    expect(select).toMatch(/ORDER BY .*"name" DESC/i);
    expect(select).toMatch(/LIMIT/i);
    expect(select).toMatch(/OFFSET/i);
    const count = queries.find((q) => /COUNT/i.test(q));
    expect(count).toMatch(/ILIKE/i);
  });
});
