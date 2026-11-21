// Outgoing email (ARCHITECTURE.md → shared/mail). Services see one small interface, so they never
// know how mail leaves: SMTP in production (Titan, from no-reply@evolviq.in), the log when no SMTP
// server is configured, and a capturing fake in tests (test/support/api-harness.ts).
import type { FastifyBaseLogger } from 'fastify';
import nodemailer from 'nodemailer';
import type { MailConfig, SmtpConfig } from '../../config.js';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface Mailer {
  /** Resolves once the server has accepted the message; rejects if it did not. */
  send(message: MailMessage): Promise<void>;
}

export function createSmtpMailer(smtp: SmtpConfig, from: string): Mailer {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    // 465 is TLS from the first byte (Titan's port); any other port must upgrade with STARTTLS.
    secure: smtp.port === 465,
    requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.password },
    // Give up in seconds, not minutes: nobody is waiting on the request that queued this mail.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(message) {
      await transport.sendMail({ from, ...message });
    },
  };
}

/**
 * No SMTP server configured: the message goes to the log instead of a mailbox. Its text — which
 * may hold a password-reset code — is logged only when `isShowingText` (local development).
 */
export function createLogMailer(log: FastifyBaseLogger, { isShowingText }: { isShowingText: boolean }): Mailer {
  return {
    async send({ to, subject, text }) {
      if (isShowingText) {
        log.info({ mail: { to, subject, text } }, 'mail not sent (no SMTP server configured); its text is logged instead');
      } else {
        log.warn({ mail: { to, subject } }, 'mail not sent: no SMTP server is configured (SMTP_HOST)');
      }
    },
  };
}

export function createMailer(config: { env: string; mail: MailConfig }, log: FastifyBaseLogger): Mailer {
  return config.mail.smtp
    ? createSmtpMailer(config.mail.smtp, config.mail.from)
    : createLogMailer(log, { isShowingText: config.env === 'development' });
}
