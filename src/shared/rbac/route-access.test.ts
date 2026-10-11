// Startup enforcement: every /api route must declare its allowed roles or be explicitly public.
import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { assertRouteDeclaresAccess, publicAccess } from './route-access.js';
import { requireRole } from './require-role.js';
import { Role } from './roles.js';

async function boot(register: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify();
  app.addHook('onRoute', assertRouteDeclaresAccess);
  // Inside a child plugin, like the real modules.
  await app.register(async (child) => register(child), { prefix: '/api/v1/things' });
  await app.ready();
  await app.close();
}

const noop = async () => ({});

describe('assertRouteDeclaresAccess', () => {
  test('a route guarded by requireRole boots', async () => {
    await expect(boot((a) => a.get('', { onRequest: [requireRole(Role.PlatformAdmin)] }, noop))).resolves.toBeUndefined();
  });

  test('a single (non-array) guard hook is recognised', async () => {
    await expect(boot((a) => a.get('', { onRequest: requireRole(Role.Teacher) }, noop))).resolves.toBeUndefined();
  });

  test('an explicitly public route boots', async () => {
    await expect(boot((a) => a.post('/login', { config: publicAccess() }, noop))).resolves.toBeUndefined();
  });

  test('a route with no declaration fails startup and names the route', async () => {
    await expect(boot((a) => a.patch('/:thingId', noop))).rejects.toThrow(
      /PATCH \/api\/v1\/things\/:thingId must declare its allowed roles/,
    );
  });

  test('authentication alone is not a role declaration', async () => {
    const authenticateOnly = async () => {};
    await expect(boot((a) => a.get('', { onRequest: [authenticateOnly] }, noop))).rejects.toThrow(/must declare/);
  });

  test('public + guard together is rejected as contradictory', async () => {
    await expect(
      boot((a) => a.get('', { config: publicAccess(), onRequest: [requireRole(Role.Parent)] }, noop)),
    ).rejects.toThrow(/pick one/);
  });

  test('routes outside /api (e.g. /docs) are not checked', async () => {
    const app = Fastify();
    app.addHook('onRoute', assertRouteDeclaresAccess);
    app.get('/docs/openapi.json', noop);
    await expect(app.ready()).resolves.toBeDefined();
    await app.close();
  });
});
