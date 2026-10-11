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
