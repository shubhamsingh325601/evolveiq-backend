import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';

const ALG = 'HS256';

// Claims are the minimum the apps and the Register API need:
//   sub = user id, role = one of six roles, sid = school id (null for platform-level roles).
export async function signAccessToken(jwtConfig, user) {
  return new SignJWT({ role: user.role, sid: user.school_id ?? null })
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
export async function verifyAccessToken(jwtConfig, token) {
  const { payload } = await jwtVerify(token, jwtConfig.secret, {
    algorithms: [ALG],
    issuer: jwtConfig.issuer,
    audience: jwtConfig.audience,
  });
  return payload;
}
