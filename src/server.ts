import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { disconnectPrismaClient, getPrismaClient } from './shared/db/prisma.js';

const config = loadConfig();
const db = getPrismaClient({ databaseUrl: config.databaseUrl, poolMax: config.dbPoolMax });
const app = await buildApp({ config, db, isLoggerEnabled: true });
for (const warning of config.warnings) app.log.warn(warning);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close(); // stop accepting, finish in-flight requests
  await disconnectPrismaClient();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
if (config.docs.isEnabled) app.log.info(`API reference: http://localhost:${config.port}/docs`);
