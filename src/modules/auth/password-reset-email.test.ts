// Unit tests for the password-reset email.
import { describe, expect, test } from 'vitest';
import { resetCodeEmail } from './password-reset-email.js';

describe('resetCodeEmail', () => {
  test('greets by first name and carries the code and how long it works', () => {
    const m = resetCodeEmail({ to: 'kavya@school.test', fullName: '  Kavya   Sharma ', code: '048213', ttlMinutes: 15 });
    expect(m.to).toBe('kavya@school.test');
    expect(m.subject).toBe('Your EvolvIQ password reset code');
    expect(m.text.split('\n')[0]).toBe('Hello Kavya,');
    expect(m.text).toContain('Your EvolvIQ password reset code is 048213');
    expect(m.text).toContain('15 minutes');
    expect(m.html).toContain('048213');
  });

  test('a name cannot inject HTML', () => {
    const m = resetCodeEmail({ to: 'x@y.test', fullName: '<img src=x onerror=alert(1)>', code: '123456', ttlMinutes: 15 });
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img');
  });
});
