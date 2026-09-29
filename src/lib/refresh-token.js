import { SignJWT, jwtVerify } from 'jose';

const ALG = 'HS256';

// Refresh-token claims are deliberately minimal: sub (user id), jti (row key in
// refresh_tokens), iss, aud, iat, exp. No role, school, name or secret — the refresh
// endpoint re-reads the user from the database instead of trusting the token.
export function signRefreshToken(jwtConfig, { userId, jti, expiresAt }) {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuer(jwtConfig.issuer)
    .setAudience(jwtConfig.audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt) // absolute epoch seconds, identical to the DB row
    .sign(jwtConfig.refresh.secret);
}

// Throws on bad signature, wrong algorithm, wrong iss/aud, expiry or missing claims.
export async function verifyRefreshToken(jwtConfig, token) {
  const { payload } = await jwtVerify(token, jwtConfig.refresh.secret, {
    algorithms: [ALG],
    issuer: jwtConfig.issuer,
    audience: jwtConfig.audience,
    requiredClaims: ['sub', 'jti', 'iat', 'exp'],
  });
  return payload;
}
