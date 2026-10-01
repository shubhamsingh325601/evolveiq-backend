// Prisma Client factory + process-wide singleton (ARCHITECTURE.md → shared/db).
// Prisma 7 talks to Postgres through the `pg` driver adapter, so the pool settings that
// protected the old raw-pg setup (bounded pool, connect timeout, statement timeout) carry over.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

export type Db = PrismaClient;

export interface DbOptions {
  readonly databaseUrl: string;
  readonly poolMax: number;
}

export function createPrismaClient({ databaseUrl, poolMax }: DbOptions): PrismaClient {
  const adapter = new PrismaPg(
    {
      connectionString: databaseUrl,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Guard against runaway queries holding a connection.
      statement_timeout: 5_000,
    },
    // An idle client erroring (e.g. DB restart) must not crash the process. The adapter
    // attaches this listener to the pool for us.
    { onPoolError: () => {} },
  );
  return new PrismaClient({ adapter });
}

let singleton: PrismaClient | undefined;

/** The one Prisma Client for this process. The first call's options win. */
export function getPrismaClient(options: DbOptions): PrismaClient {
  singleton ??= createPrismaClient(options);
  return singleton;
}

export async function disconnectPrismaClient(): Promise<void> {
  await singleton?.$disconnect();
  singleton = undefined;
}
