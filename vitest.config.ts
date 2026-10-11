import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile(); // pick up TEST_DATABASE_URL from .env when present
} catch {
  // no .env — rely on the environment
}

const TEST_ENV = {
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  JWT_REFRESH_SECRET: 'test-refresh-secret-test-refresh-secret-0123456789',
  JWT_TTL_SECONDS: '3600',
  JWT_REFRESH_TTL_SECONDS: '604800',
  LOGIN_MAX_ATTEMPTS: '5',
  LOGIN_LOCK_MINUTES: '15',
  API_DOCS_ENABLED: 'true',
};

// API (Supertest) and repository tests — need TEST_DATABASE_URL.
const INTEGRATION = ['src/**/*.routes*.test.ts', 'src/**/*.repository*.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        // Pure unit / service tests — no database.
        // Tests are colocated with the code (docs/NAMING_CONVENTIONS.md). Tests of
        // *.routes.ts / *.repository.ts files hit a real database; everything else is unit.
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: INTEGRATION,
          environment: 'node',
          env: TEST_ENV,
        },
      },
      {
        // API integration tests — Supertest against the real app and a real PostgreSQL.
        test: {
          name: 'integration',
          include: INTEGRATION,
          environment: 'node',
          globalSetup: ['test/support/global-setup.ts'],
          // One database: files must not run concurrently (each resets the data).
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env: {
            ...TEST_ENV,
            DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
            TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
          },
        },
      },
    ],
  },
});
