// The email that carries a password-reset code. No links: the code is typed into the same sign-in
// screen it was asked for on, which works alike on every site and inside the installed apps.
import type { MailMessage } from '../../shared/mail/mailer.js';

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

export function resetCodeEmail(a: { to: string; fullName: string; code: string; ttlMinutes: number }): MailMessage {
  const firstName = a.fullName.trim().split(/\s+/)[0] ?? '';
  const greeting = firstName ? `Hello ${firstName},` : 'Hello,';
  const howToUse = `Enter it on the sign-in screen where you asked for it. It works once, for ${a.ttlMinutes} minutes.`;
  const ifNotYou = "If you didn't ask to reset your password, you can ignore this email. Your password stays the same.";

  const text = [greeting, '', `Your EvolvIQ password reset code is ${a.code}`, '', howToUse, '', ifNotYou, '', 'EvolvIQ'].join('\n');
  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f3fa;">
    <div style="max-width:480px;margin:0 auto;padding:32px;background:#ffffff;border-radius:16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1f1d2b;">
      <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 8px;">Your EvolvIQ password reset code is</p>
      <p style="margin:0 0 24px;font-size:34px;font-weight:700;letter-spacing:8px;">${escapeHtml(a.code)}</p>
      <p style="margin:0 0 16px;">${escapeHtml(howToUse)}</p>
      <p style="margin:0 0 24px;color:#6b6880;">${escapeHtml(ifNotYou)}</p>
      <p style="margin:0;font-weight:600;">EvolvIQ</p>
    </div>
  </body>
</html>`;

  return { to: a.to, subject: 'Your EvolvIQ password reset code', text, html };
}
