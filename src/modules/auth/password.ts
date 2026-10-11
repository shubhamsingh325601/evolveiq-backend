import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

// argon2id with OWASP-recommended minimums (19 MiB, 2 iterations, 1 lane).
// argon2 runs on libuv's thread pool, so hashing never blocks the event loop.
const OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

export function hashSecret(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false; // malformed hash → treat as mismatch, never throw to the client
  }
}

// A real hash of a random value, computed once at startup. When a login identifier does
// not exist we still verify against this, so "unknown user" and "wrong password" take
// the same time and cannot be told apart (timing-based user enumeration).
let dummyHash: string | undefined;

export async function initDummyHash(): Promise<void> {
  dummyHash ??= await hashSecret(randomBytes(32).toString('hex'));
}

export function getDummyHash(): string {
  if (!dummyHash) throw new Error('initDummyHash() must run before the first login');
  return dummyHash;
}
