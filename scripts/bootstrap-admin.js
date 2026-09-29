// Creates the FIRST Platform Admin. Registration is admin-only, so someone has to exist
// before the Register API can be called. Run once per environment from a trusted shell.
import pg from 'pg';
import { hashSecret } from '../src/lib/password.js';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const fullName = process.env.BOOTSTRAP_ADMIN_NAME?.trim();

if (!email || !fullName || !password || password.length < 10 || password.length > 128) {
  console.error('Set BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME and BOOTSTRAP_ADMIN_PASSWORD (10–128 chars).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rowCount } = await client.query(
    `INSERT INTO users (role, full_name, email, secret_hash)
     VALUES ('platform_admin', $1, $2, $3)
     ON CONFLICT (email) WHERE email IS NOT NULL DO NOTHING`,
    [fullName, email, await hashSecret(password)],
  );
  console.log(rowCount ? `Platform Admin created: ${email}` : `Already exists: ${email}`);
} finally {
  await client.end();
}
