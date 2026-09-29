import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createPool(config);
const app = await buildApp({ config, db, logger: true });

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  await app.close(); // stop accepting, finish in-flight requests
  await db.end();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
