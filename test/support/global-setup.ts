// Runs once before the integration suite: rebuilds the TEST database from scratch by
// applying every prisma/migrations/*/migration.sql in order — the same SQL Prisma Migrate
// applies — so the tests also prove the migrations work on an empty database.
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const MIGRATIONS_DIR = new URL('../../prisma/migrations/', import.meta.url);

export function assertTestDatabase(url: string | undefined): string {
  if (!url) throw new Error('Set TEST_DATABASE_URL (a dedicated, disposable database) to run integration tests.');
  const dbName = new URL(url).pathname.slice(1);
  // This suite DROPS the schema. Refuse anything that doesn't look like a test database.
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to wipe "${dbName}": TEST_DATABASE_URL must point at a database whose name contains "test".`);
  }
  return url;
}

export default async function setup(): Promise<void> {
  const url = assertTestDatabase(process.env.TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    const dirs = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const dir of dirs) {
      await client.query(await readFile(new URL(`${dir}/migration.sql`, MIGRATIONS_DIR), 'utf8'));
    }
  } finally {
    await client.end();
  }
}
