// Reads and validates configuration once at startup. Fails fast on bad secrets.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function int(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig() {
  const jwtSecret = required('JWT_SECRET');
  if (Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('JWT_SECRET must be at least 32 bytes');
  }

  const refreshSecret = required('JWT_REFRESH_SECRET');
  if (Buffer.byteLength(refreshSecret) < 32) {
    throw new Error('JWT_REFRESH_SECRET must be at least 32 bytes');
  }
  if (refreshSecret === jwtSecret) {
    // A shared secret would let an access token pass as a refresh token and vice versa.
    throw new Error('JWT_REFRESH_SECRET must be different from JWT_SECRET');
  }
  const accessTtl = int('JWT_TTL_SECONDS', 3600, 60, 86400);
  const refreshTtl = int('JWT_REFRESH_TTL_SECONDS', 604800, 300, 7776000); // default 7 days, max 90
  if (refreshTtl <= accessTtl) {
    throw new Error('JWT_REFRESH_TTL_SECONDS must be greater than JWT_TTL_SECONDS');
  }

  return Object.freeze({
    env: process.env.NODE_ENV ?? 'development',
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
  });
}
