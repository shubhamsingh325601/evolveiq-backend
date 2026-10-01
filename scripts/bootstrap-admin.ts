// Creates the FIRST Platform Admin. Registration is admin-only, so someone has to exist
// before the Register API can be called. Run once per environment from a trusted shell.
import { hashSecret } from '../src/modules/auth/password.js';
import { createPrismaClient } from '../src/shared/db/prisma.js';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const fullName = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('Set DATABASE_URL.');
  process.exit(1);
}
if (!email || !fullName || !password || password.length < 10 || password.length > 128) {
  console.error('Set BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_NAME and BOOTSTRAP_ADMIN_PASSWORD (10–128 chars).');
  process.exit(1);
}

const db = createPrismaClient({ databaseUrl, poolMax: 1 });
try {
  // Idempotent: the partial unique index on email makes a second run a no-op.
  const inserted = await db.$executeRaw`
    INSERT INTO users (role, full_name, email, secret_hash)
    VALUES ('platform_admin', ${fullName}, ${email}, ${await hashSecret(password)})
    ON CONFLICT (email) WHERE email IS NOT NULL DO NOTHING`;
  console.log(inserted ? `Platform Admin created: ${email}` : `Already exists: ${email}`);
} finally {
  await db.$disconnect();
}
