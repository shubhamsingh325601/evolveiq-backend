import { randomUUID } from 'node:crypto';
import type { JWTPayload } from 'jose';
import type { AppConfig } from '../../config.js';
import { Errors } from '../../shared/errors/index.js';
import { signAccessToken } from './access-token.js';
import { signRefreshToken, verifyRefreshToken } from './refresh-token.js';
import type { RefreshTokenRepository } from './refresh-token.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TokenPair {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}

export function createRefreshTokenService(deps: { repository: RefreshTokenRepository; config: AppConfig }) {
  const { repository: repo } = deps;
  const jwt = deps.config.jwt;
  const expiry = () => Math.floor(Date.now() / 1000) + jwt.refresh.ttlSeconds;

  // Called by login after the user has been fully authenticated.
  async function issue(userId: string): Promise<{ refreshToken: string; refreshExpiresIn: number }> {
    const jti = randomUUID();
    const expiresAt = expiry();
    const [refreshToken] = await Promise.all([
      signRefreshToken(jwt, { userId, jti, expiresAt }),
      repo.insertRefreshToken({ jti, userId, familyId: jti, expiresAt }),
    ]);
    return { refreshToken, refreshExpiresIn: jwt.refresh.ttlSeconds };
  }

  // POST /refresh: verify → rotate atomically → new access + refresh token.
  async function refresh(token: string): Promise<TokenPair> {
    let claims: JWTPayload;
    try {
      claims = await verifyRefreshToken(jwt, token);
    } catch {
      throw Errors.invalidRefreshToken(); // never reveal which check failed
    }
    // Validly signed but malformed ids would make Postgres throw → treat as invalid.
    const { sub, jti } = claims;
    if (typeof sub !== 'string' || typeof jti !== 'string' || !UUID.test(sub) || !UUID.test(jti)) {
      throw Errors.invalidRefreshToken();
    }

    const newJti = randomUUID();
    const expiresAt = expiry();
    const row = await repo.rotateRefreshToken({ jti, userId: sub, newJti, expiresAt });

    if (!row.was_token_live) {
      // Unknown, expired in DB, revoked, or lost a concurrent rotation.
      await repo.revokeFamilyOfRevokedToken({ jti, userId: sub });
      throw Errors.invalidRefreshToken();
    }
    // The presented token is now revoked. Deactivated user → same code as login.
    if (row.id && !row.is_active) throw Errors.accountDisabled();
    if (!row.is_rotated || !row.id || !row.role) throw Errors.invalidRefreshToken();

    // Access-token claims come from the user's CURRENT row, via the unchanged signer.
    const user = { id: row.id, role: row.role, schoolId: row.school_id };
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

export type RefreshTokenService = ReturnType<typeof createRefreshTokenService>;
