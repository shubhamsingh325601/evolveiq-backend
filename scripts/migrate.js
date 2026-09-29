// Applies db/migrations/*.sql in order, once each. Usage: npm run db:migrate [-- --seed-dev]
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const dir = new URL('../db/migrations/', import.meta.url);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    await client.query(await readFile(new URL(file, dir), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    console.log(`applied ${file}`);
  }

  if (process.argv.includes('--seed-dev')) {
    await client.query(await readFile(new URL('../db/seed.dev.sql', import.meta.url), 'utf8'));
    console.log('seeded demo schools');
  }
} finally {
  await client.end();
}
