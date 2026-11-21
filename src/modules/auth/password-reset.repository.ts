// Database access for "Forgot password" (asked for on 21 Nov 2026). No business rules: the limits
// come from password-reset.service.ts. Expiry and the throttle use the database clock, like the
// login lockout.
import type { Db } from '../../shared/db/prisma.js';
import { replaceSecret } from './secret.repository.js';

export interface ResetAccount {
  id: string;
  fullName: string;
}

export interface TakenAttempt {
  id: string;
  user_id: string;
  code_hash: string;
}

export function createPasswordResetRepository(db: Db) {
  return {
    // Only an active adult gets a code: students sign in with a PIN, and a deactivated account
    // can't sign in at all.
    findActiveAdult(email: string): Promise<ResetAccount | null> {
      return db.user.findFirst({
        where: { email, isActive: true, role: { not: 'student' } },
        select: { id: true, fullName: true },
      });
    },

    // Stores a new code, unless the account got one in the last `resendAfterSeconds` or already
    // `maxPerHour` in the last hour. The user's row is locked first, so two requests at once
    // can't both slip past the throttle. Codes older than a day are tidied away.
    insertCode(a: {
      userId: string;
      codeHash: string;
      ttlMinutes: number;
      resendAfterSeconds: number;
      maxPerHour: number;
    }): Promise<boolean> {
      return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM users WHERE id = ${a.userId}::uuid FOR UPDATE`;
        const [recent] = await tx.$queryRaw<{ last_minute: number; last_hour: number }[]>`
          SELECT count(*) FILTER (WHERE created_at > now() - make_interval(secs => ${a.resendAfterSeconds}::int))::int AS last_minute,
                 count(*)::int AS last_hour
          FROM password_reset_codes
          WHERE user_id = ${a.userId}::uuid AND created_at > now() - interval '1 hour'`;
        if (!recent || recent.last_minute > 0 || recent.last_hour >= a.maxPerHour) return false;

        await tx.$executeRaw`
          DELETE FROM password_reset_codes
          WHERE user_id = ${a.userId}::uuid AND created_at < now() - interval '1 day'`;
        await tx.$executeRaw`
          INSERT INTO password_reset_codes (user_id, code_hash, expires_at)
          VALUES (${a.userId}::uuid, ${a.codeHash}, now() + make_interval(mins => ${a.ttlMinutes}::int))`;
        return true;
      });
    },

    // Takes one try of the account's NEWEST code, if that code is still usable (unused, unexpired,
    // under `maxAttempts` tries), and returns it to be checked. One statement: under parallel
    // guesses Postgres re-checks `attempts` on the locked row, so no more tries are taken than
    // there are. An older code never works once a newer one exists.
    async takeAttempt(email: string, maxAttempts: number): Promise<TakenAttempt | null> {
      const rows = await db.$queryRaw<TakenAttempt[]>`
        UPDATE password_reset_codes SET attempts = attempts + 1
        WHERE id = (
            SELECT c.id
            FROM password_reset_codes c JOIN users u ON u.id = c.user_id
            WHERE u.email = ${email} AND u.is_active AND u.role <> 'student'
            ORDER BY c.created_at DESC, c.id DESC
            LIMIT 1
          )
          AND used_at IS NULL AND expires_at > now() AND attempts < ${maxAttempts}::int
        RETURNING id, user_id, code_hash`;
      return rows[0] ?? null;
    },

    // The code was right: use it up and set the new password in one transaction. False when the
    // same code was used a moment ago (two right answers at once: only one wins).
    completeReset(a: { codeId: string; userId: string; secretHash: string }): Promise<boolean> {
      return db.$transaction(async (tx) => {
        const used = await tx.$executeRaw`
          UPDATE password_reset_codes SET used_at = now()
          WHERE id = ${a.codeId}::uuid AND used_at IS NULL`;
        if (used === 0) return false;
        return replaceSecret(tx, a.userId, a.secretHash);
      });
    },
  };
}

export type PasswordResetRepository = ReturnType<typeof createPasswordResetRepository>;
