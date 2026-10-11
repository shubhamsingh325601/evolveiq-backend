// Prisma CLI configuration (Prisma 7). The CLI does not read .env by itself, so load it
// here when present; real environments inject DATABASE_URL directly.
import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile();
} catch {
  // No .env file — rely on the process environment.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Only needed by migrate / db commands; `prisma generate` works without it.
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
