import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { randomUUID } from 'node:crypto';
import type { JwtConfig } from '../../config.js';

const ALG = 'HS256';

export interface AccessTokenSubject {
  readonly id: string;
  readonly role: string;
  readonly schoolId: string | null;
}

// Claims are the minimum the apps and the protected APIs need:
//   sub = user id, role = one of six roles, sid = school id (null for platform-level roles).
export function signAccessToken(jwtConfig: JwtConfig, user: AccessTokenSubject): Promise<string> {
  return new SignJWT({ role: user.role, sid: user.schoolId ?? null })
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(jwtConfig.issuer)
    .setAudience(jwtConfig.audience)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${jwtConfig.ttlSeconds}s`)
    .sign(jwtConfig.secret);
}

// Throws on any problem (bad signature, expired, wrong iss/aud, alg confusion).
export async function verifyAccessToken(jwtConfig: JwtConfig, token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, jwtConfig.secret, {
    algorithms: [ALG],
    issuer: jwtConfig.issuer,
    audience: jwtConfig.audience,
  });
  return payload;
}
