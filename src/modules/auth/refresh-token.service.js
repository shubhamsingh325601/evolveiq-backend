import { randomUUID } from 'node:crypto';
import { Errors } from '../../lib/errors.js';
import { signAccessToken } from '../../lib/token.js';
import { signRefreshToken, verifyRefreshToken } from '../../lib/refresh-token.js';
import * as repo from './refresh-token.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRefreshTokenService({ db, config }) {
  const jwt = config.jwt;
  const expiry = () => Math.floor(Date.now() / 1000) + jwt.refresh.ttlSeconds;

  // Called by login after the user has been fully authenticated.
  async function issue(userId) {
    const jti = randomUUID();
    const expiresAt = expiry();
    const [refreshToken] = await Promise.all([
      signRefreshToken(jwt, { userId, jti, expiresAt }),
      repo.insertRefreshToken(db, { jti, userId, familyId: jti, expiresAt }),
    ]);
    return { refreshToken, refreshExpiresIn: jwt.refresh.ttlSeconds };
  }

  // POST /refresh: verify → rotate atomically → new access + refresh token.
  async function refresh(token) {
    let claims;
    try {
      claims = await verifyRefreshToken(jwt, token);
    } catch {
      throw Errors.invalidRefreshToken(); // never reveal which check failed
    }
    // Validly signed but malformed ids would make Postgres throw → treat as invalid.
    if (!UUID.test(claims.sub) || !UUID.test(claims.jti)) throw Errors.invalidRefreshToken();

    const newJti = randomUUID();
    const expiresAt = expiry();
    const row = await repo.rotateRefreshToken(db, {
      jti: claims.jti, userId: claims.sub, newJti, expiresAt,
    });

    if (!row.token_ok) {
      // Unknown, expired in DB, revoked, or lost a concurrent rotation.
      await repo.revokeFamilyOfRevokedToken(db, { jti: claims.jti, userId: claims.sub });
      throw Errors.invalidRefreshToken();
    }
    // The presented token is now revoked. Deactivated user → same code as login.
    if (row.id && !row.is_active) throw Errors.accountDisabled();
    if (!row.rotated) throw Errors.invalidRefreshToken();

    // Access-token claims come from the user's CURRENT row, via the unchanged signer.
    const user = { id: row.id, role: row.role, school_id: row.school_id };
    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken(jwt, user),
      signRefreshToken(jwt, { userId: row.id, jti: newJti, expiresAt }),
    ]);
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: jwt.ttlSeconds,
      refreshToken,
      refreshExpiresIn: jwt.refresh.ttlSeconds,
    };
  }

  return { issue, refresh };
}
