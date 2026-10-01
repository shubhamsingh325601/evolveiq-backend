import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { JwtConfig } from '../../config.js';

const ALG = 'HS256';

export interface RefreshTokenClaims {
  readonly userId: string;
  readonly jti: string;
  /** Absolute expiry, epoch seconds — identical to the database row. */
  readonly expiresAt: number;
}

// Refresh-token claims are deliberately minimal: sub (user id), jti (row key in
// refresh_tokens), iss, aud, iat, exp. No role, school, name or secret — the refresh
// endpoint re-reads the user from the database instead of trusting the token.
export function signRefreshToken(
  jwtConfig: JwtConfig,
  { userId, jti, expiresAt }: RefreshTokenClaims,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuer(jwtConfig.issuer)
    .setAudience(jwtConfig.audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(jwtConfig.refresh.secret);
}

// Throws on bad signature, wrong algorithm, wrong iss/aud, expiry or missing claims.
export async function verifyRefreshToken(jwtConfig: JwtConfig, token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwtConfig.refresh.secret, {
    algorithms: [ALG],
    issuer: jwtConfig.issuer,
    audience: jwtConfig.audience,
    requiredClaims: ['sub', 'jti', 'iat', 'exp'],
  });
  return payload;
}
