import 'fastify';
import type { onRequestAsyncHookHandler } from 'fastify';
import type { Actor } from '../shared/rbac/actor.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `app.authenticate`; null on unauthenticated routes. */
    actor: Actor | null;
  }

  interface FastifyInstance {
    /** Authentication hook: verifies the Bearer access token and sets `request.actor`. */
    authenticate: onRequestAsyncHookHandler;
  }
}
