// Reads and validates configuration once at startup. Fails fast on bad secrets.

export interface JwtConfig {
  readonly secret: Uint8Array;
  readonly issuer: string;
  readonly audience: string;
  readonly ttlSeconds: number;
  readonly refresh: {
    readonly secret: Uint8Array;
    readonly ttlSeconds: number;
  };
}

export interface AppConfig {
  readonly env: string;
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly dbPoolMax: number;
  readonly jwt: JwtConfig;
  readonly login: {
    readonly maxAttempts: number;
    readonly lockMinutes: number;
  };
  readonly docs: {
    /** Serve the OpenAPI document and the Scalar API reference under /docs. */
    readonly isEnabled: boolean;
  };
  /** Non-fatal configuration problems (e.g. deprecated variable names), logged at startup. */
  readonly warnings: readonly string[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}

// JWT_ACCESS_SECRET is the name from docs/NAMING_CONVENTIONS.md. JWT_SECRET is the name
// earlier versions used; it is still accepted (with a warning) so existing .env files keep
// working. Remove the fallback once every environment has been updated.
function accessSecret(warnings: string[]): string {
  const current = process.env.JWT_ACCESS_SECRET;
  const legacy = process.env.JWT_SECRET;
  if (current) {
    if (legacy) warnings.push('JWT_SECRET is ignored because JWT_ACCESS_SECRET is set; remove JWT_SECRET.');
    return current;
  }
  if (legacy) {
    warnings.push('JWT_SECRET is deprecated; rename it to JWT_ACCESS_SECRET.');
    return legacy;
  }
  throw new Error('Missing required environment variable: JWT_ACCESS_SECRET');
}

export function loadConfig(): AppConfig {
  const warnings: string[] = [];
  const jwtSecret = accessSecret(warnings);
  if (Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('JWT_ACCESS_SECRET must be at least 32 bytes');
  }

  const refreshSecret = required('JWT_REFRESH_SECRET');
  if (Buffer.byteLength(refreshSecret) < 32) {
    throw new Error('JWT_REFRESH_SECRET must be at least 32 bytes');
  }
  if (refreshSecret === jwtSecret) {
    // A shared secret would let an access token pass as a refresh token and vice versa.
    throw new Error('JWT_REFRESH_SECRET must be different from JWT_ACCESS_SECRET');
  }
  const accessTtl = int('JWT_TTL_SECONDS', 3600, 60, 86400);
  const refreshTtl = int('JWT_REFRESH_TTL_SECONDS', 604800, 300, 7776000); // default 7 days, max 90
  if (refreshTtl <= accessTtl) {
    throw new Error('JWT_REFRESH_TTL_SECONDS must be greater than JWT_TTL_SECONDS');
  }

  const env = process.env.NODE_ENV ?? 'development';

  return Object.freeze({
    env,
    host: process.env.HOST ?? '0.0.0.0',
    port: int('PORT', 3000, 1, 65535),
    databaseUrl: required('DATABASE_URL'),
    dbPoolMax: int('DB_POOL_MAX', 10, 1, 200),
    jwt: Object.freeze({
      secret: new TextEncoder().encode(jwtSecret),
      issuer: process.env.JWT_ISSUER ?? 'evolviq-api',
      audience: process.env.JWT_AUDIENCE ?? 'evolviq-apps',
      ttlSeconds: accessTtl,
      refresh: Object.freeze({
        secret: new TextEncoder().encode(refreshSecret),
        ttlSeconds: refreshTtl,
      }),
    }),
    login: Object.freeze({
      maxAttempts: int('LOGIN_MAX_ATTEMPTS', 5, 1, 100),
      lockMinutes: int('LOGIN_LOCK_MINUTES', 15, 1, 1440),
    }),
    docs: Object.freeze({
      // On by default everywhere except production; opt in explicitly there.
      isEnabled: bool('API_DOCS_ENABLED', env !== 'production'),
    }),
    warnings: Object.freeze(warnings),
  });
}
