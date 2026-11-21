// "Forgot password" for adults (asked for on 21 Nov 2026): a 6-digit code by email, then a new
// password. Students have no email: their parent or School Admin sets a new PIN (users module).
//
//   request  Always the same answer. The work — finding the account, storing the code, sending the
//            email — runs after the reply (BackgroundTasks), so neither the answer nor its timing
//            tells whether an email address is registered.
//   reset    Only the account's newest code works: for 15 minutes, 5 tries, once. Success sets the
//            password, clears the login lockout and ends every session of the account.
import { randomInt } from 'node:crypto';
import type { BackgroundTasks } from '../../shared/background/background-tasks.js';
import { Errors } from '../../shared/errors/index.js';
import type { Mailer } from '../../shared/mail/mailer.js';
import type { ResetPasswordBody } from './auth.schemas.js';
import { getDummyHash, hashSecret, verifySecret } from './password.js';
import { resetCodeEmail } from './password-reset-email.js';
import type { PasswordResetRepository } from './password-reset.repository.js';

export const RESET_CODE_TTL_MINUTES = 15;
export const RESET_CODE_MAX_ATTEMPTS = 5;
/** A new code no sooner than this after the last one… */
export const RESET_CODE_RESEND_SECONDS = 60;
/** …and no more than this many an hour, so nobody can flood someone's inbox. */
export const RESET_CODES_PER_HOUR = 5;

export const FORGOT_PASSWORD_MESSAGE =
  `If an account uses this email, a 6-digit code is on its way. It works for ${RESET_CODE_TTL_MINUTES} minutes.`;

export function createPasswordResetService(deps: {
  repository: PasswordResetRepository;
  mailer: Mailer;
  backgroundTasks: BackgroundTasks;
}) {
  const { repository: repo, mailer, backgroundTasks } = deps;

  async function sendCode(email: string): Promise<void> {
    const account = await repo.findActiveAdult(email);
    if (!account) return;

    // 000000–999999 from the operating system's CSPRNG. Stored only as an argon2id hash.
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const isStored = await repo.insertCode({
      userId: account.id,
      codeHash: await hashSecret(code),
      ttlMinutes: RESET_CODE_TTL_MINUTES,
      resendAfterSeconds: RESET_CODE_RESEND_SECONDS,
      maxPerHour: RESET_CODES_PER_HOUR,
    });
    if (!isStored) return; // throttled: a code went out moments ago, or too many this hour

    await mailer.send(resetCodeEmail({ to: email, fullName: account.fullName, code, ttlMinutes: RESET_CODE_TTL_MINUTES }));
  }

  /** POST /auth/forgot-password. Returns at once; any email follows in the background. */
  function requestReset(email: string): void {
    const normalised = email.trim().toLowerCase();
    backgroundTasks.run('password-reset email', () => sendCode(normalised));
  }

  /** POST /auth/reset-password. */
  async function resetPassword(body: ResetPasswordBody): Promise<void> {
    const attempt = await repo.takeAttempt(body.email.trim().toLowerCase(), RESET_CODE_MAX_ATTEMPTS);

    // Always one argon2 verify — against a dummy hash when there is no usable code — so the
    // response time doesn't tell an unknown email from a wrong code.
    const isMatch = await verifySecret(attempt?.code_hash ?? getDummyHash(), body.code);
    if (!attempt || !isMatch) throw Errors.invalidResetCode();

    const isReset = await repo.completeReset({
      codeId: attempt.id,
      userId: attempt.user_id,
      secretHash: await hashSecret(body.newPassword),
    });
    if (!isReset) throw Errors.invalidResetCode(); // the same code was used a moment ago
  }

  return { requestReset, resetPassword };
}

export type PasswordResetService = ReturnType<typeof createPasswordResetService>;
