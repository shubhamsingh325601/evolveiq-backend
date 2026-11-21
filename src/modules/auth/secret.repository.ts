// Setting a new password or PIN, whichever way it happens — forgot password, change password, an
// admin, a parent — goes through here, so no path can forget a step: the new hash, a clean
// lockout, and every session of the account ended (its refresh tokens revoked). It runs inside
// the caller's transaction, next to whatever else that change needs (e.g. using up a reset code).
import type { Prisma } from '../../generated/prisma/client.js';

/** False when there is no such user. */
export async function replaceSecret(tx: Prisma.TransactionClient, userId: string, secretHash: string): Promise<boolean> {
  const updated = await tx.$executeRaw`
    UPDATE users
    SET secret_hash = ${secretHash}, failed_login_attempts = 0, locked_until = NULL, updated_at = now()
    WHERE id = ${userId}::uuid`;
  if (updated === 0) return false;
  await tx.$executeRaw`
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`;
  return true;
}
