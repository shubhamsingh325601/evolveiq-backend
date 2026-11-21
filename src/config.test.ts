// Unit tests for configuration loading. The first four cases were ported unchanged from the
// previous refresh-token suite; the rest cover the JWT_ACCESS_SECRET rename.
import { describe, expect, test } from 'vitest';
import { loadConfig } from './config.js';

const DB = 'postgres://u:p@localhost:5432/evolviq_config_test';
const ACCESS = 'access-secret-access-secret-access-secret-01';
const REFRESH = 'refresh-secret-refresh-secret-refresh-secret-02';

const withEnv = <T>(patch: Record<string, string | undefined>, fn: () => T): T => {
  const saved = { ...process.env };
  process.env.DATABASE_URL ??= DB;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally { process.env = saved; }
};

describe('configuration validation', () => {
  test('JWT_REFRESH_SECRET is required', () => {
    expect(() => withEnv({ JWT_REFRESH_SECRET: undefined }, loadConfig)).toThrow(/JWT_REFRESH_SECRET/);
  });
  test('JWT_REFRESH_SECRET must be ≥ 32 bytes', () => {
    expect(() => withEnv({ JWT_REFRESH_SECRET: 'short' }, loadConfig)).toThrow(/at least 32 bytes/);
  });
  test('JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET', () => {
    expect(() => withEnv({ JWT_REFRESH_SECRET: process.env.JWT_ACCESS_SECRET }, loadConfig)).toThrow(/different/);
  });
  test('JWT_REFRESH_TTL_SECONDS must be an integer in range and greater than the access TTL', () => {
    expect(() => withEnv({ JWT_REFRESH_TTL_SECONDS: 'abc' }, loadConfig)).toThrow(/JWT_REFRESH_TTL_SECONDS/);
    expect(() => withEnv({ JWT_REFRESH_TTL_SECONDS: '99999999' }, loadConfig)).toThrow(/JWT_REFRESH_TTL_SECONDS/);
    expect(() => withEnv({ JWT_REFRESH_TTL_SECONDS: '1800', JWT_TTL_SECONDS: '3600' }, loadConfig)).toThrow(/greater than/);
    expect(withEnv({ JWT_REFRESH_TTL_SECONDS: '86400' }, loadConfig).jwt.refresh.ttlSeconds).toBe(86400);
  });
});

describe('JWT_ACCESS_SECRET (renamed from JWT_SECRET)', () => {
  const secretOf = (cfg: ReturnType<typeof loadConfig>) => new TextDecoder().decode(cfg.jwt.secret);

  test('JWT_ACCESS_SECRET is used, with no warnings', () => {
    const cfg = withEnv({ JWT_ACCESS_SECRET: ACCESS, JWT_SECRET: undefined, JWT_REFRESH_SECRET: REFRESH }, loadConfig);
    expect(secretOf(cfg)).toBe(ACCESS);
    expect(cfg.warnings).toEqual([]);
  });

  test('legacy JWT_SECRET alone still works, with a deprecation warning', () => {
    const cfg = withEnv({ JWT_ACCESS_SECRET: undefined, JWT_SECRET: ACCESS, JWT_REFRESH_SECRET: REFRESH }, loadConfig);
    expect(secretOf(cfg)).toBe(ACCESS);
    expect(cfg.warnings).toEqual(['JWT_SECRET is deprecated; rename it to JWT_ACCESS_SECRET.']);
  });

  test('when both are set, JWT_ACCESS_SECRET wins and JWT_SECRET is reported as ignored', () => {
    const cfg = withEnv({ JWT_ACCESS_SECRET: ACCESS, JWT_SECRET: 'some-old-secret-some-old-secret-some-old', JWT_REFRESH_SECRET: REFRESH }, loadConfig);
    expect(secretOf(cfg)).toBe(ACCESS);
    expect(cfg.warnings).toEqual(['JWT_SECRET is ignored because JWT_ACCESS_SECRET is set; remove JWT_SECRET.']);
  });

  test('neither set → startup fails naming the new variable', () => {
    expect(() => withEnv({ JWT_ACCESS_SECRET: undefined, JWT_SECRET: undefined }, loadConfig)).toThrow(
      'Missing required environment variable: JWT_ACCESS_SECRET',
    );
  });

  test('length and difference rules apply to the legacy name too', () => {
    expect(() => withEnv({ JWT_ACCESS_SECRET: undefined, JWT_SECRET: 'short' }, loadConfig)).toThrow(/JWT_ACCESS_SECRET must be at least 32 bytes/);
    expect(() => withEnv({ JWT_ACCESS_SECRET: undefined, JWT_SECRET: REFRESH, JWT_REFRESH_SECRET: REFRESH }, loadConfig)).toThrow(/different/);
  });
});

describe('CORS_ORIGINS', () => {
  test('unset outside production → any origin is allowed (local development)', () => {
    expect(withEnv({ CORS_ORIGINS: undefined, NODE_ENV: 'development' }, loadConfig).cors.origins).toBe(true);
    expect(withEnv({ CORS_ORIGINS: ' , ', NODE_ENV: 'test' }, loadConfig).cors.origins).toBe(true);
  });

  test('unset or blank in production → startup fails naming the variable', () => {
    expect(() => withEnv({ CORS_ORIGINS: undefined, NODE_ENV: 'production' }, loadConfig)).toThrow(/CORS_ORIGINS/);
    expect(() => withEnv({ CORS_ORIGINS: ' , ', NODE_ENV: 'production' }, loadConfig)).toThrow(/CORS_ORIGINS/);
  });

  test('a comma-separated list is trimmed, loses trailing slashes and is lower-cased', () => {
    const cfg = withEnv(
      { NODE_ENV: 'production', CORS_ORIGINS: ' https://teacher.evolviq.in/ ,https://Family.evolviq.in,http://localhost:5174' },
      loadConfig,
    );
    expect(cfg.cors.origins).toEqual(['https://teacher.evolviq.in', 'https://family.evolviq.in', 'http://localhost:5174']);
  });

  test('anything that is not scheme://host[:port] is rejected', () => {
    for (const bad of ['*', 'teacher.evolviq.in', 'https://evolviq.in/app', 'ftp://evolviq.in', 'https://user:pw@evolviq.in', 'https://evolviq.in?x=1']) {
      expect(() => withEnv({ CORS_ORIGINS: bad }, loadConfig), bad).toThrow(/CORS_ORIGINS has an invalid origin/);
    }
  });
});

describe('SMTP_* (outgoing mail: password-reset codes, 21 Nov 2026)', () => {
  // JWT_SECRET too: a local .env may set the legacy name, which adds a warning of its own.
  const NO_SMTP = { SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined, MAIL_FROM: undefined, JWT_SECRET: undefined };

  test('unset → mail is logged, not sent; no warning outside production', () => {
    const cfg = withEnv({ ...NO_SMTP, NODE_ENV: 'development' }, loadConfig);
    expect(cfg.mail).toEqual({ smtp: null, from: 'EvolvIQ <no-reply@evolviq.in>' });
    expect(cfg.warnings).toEqual([]);
  });

  test('unset in production → the server still starts, with a warning', () => {
    const cfg = withEnv({ ...NO_SMTP, NODE_ENV: 'production', CORS_ORIGINS: 'https://teacher.evolviq.in' }, loadConfig);
    expect(cfg.mail.smtp).toBeNull();
    expect(cfg.warnings).toEqual([
      'SMTP_HOST is not set, so password-reset emails cannot be sent. Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD.',
    ]);
  });

  test('SMTP_HOST set → user and password are required; the port defaults to 465', () => {
    expect(() => withEnv({ ...NO_SMTP, SMTP_HOST: 'smtp.titan.email' }, loadConfig)).toThrow(/SMTP_USER/);
    expect(() => withEnv({ ...NO_SMTP, SMTP_HOST: 'smtp.titan.email', SMTP_USER: 'no-reply@evolviq.in' }, loadConfig)).toThrow(/SMTP_PASSWORD/);
    const cfg = withEnv(
      { ...NO_SMTP, SMTP_HOST: ' smtp.titan.email ', SMTP_USER: 'no-reply@evolviq.in', SMTP_PASSWORD: 'pw', MAIL_FROM: 'EvolvIQ <hello@evolviq.in>' },
      loadConfig,
    );
    expect(cfg.mail).toEqual({
      smtp: { host: 'smtp.titan.email', port: 465, user: 'no-reply@evolviq.in', password: 'pw' },
      from: 'EvolvIQ <hello@evolviq.in>',
    });
  });

  test('SMTP_PORT must be a valid port', () => {
    const smtp = { ...NO_SMTP, SMTP_HOST: 'smtp.titan.email', SMTP_USER: 'u', SMTP_PASSWORD: 'p' };
    expect(() => withEnv({ ...smtp, SMTP_PORT: 'abc' }, loadConfig)).toThrow(/SMTP_PORT/);
    expect(withEnv({ ...smtp, SMTP_PORT: '587' }, loadConfig).mail.smtp?.port).toBe(587);
  });
});
