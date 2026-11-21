import 'fastify';
import type { onRequestAsyncHookHandler } from 'fastify';
import type { BackgroundTasks } from '../shared/background/background-tasks.js';
import type { Actor } from '../shared/rbac/actor.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `app.authenticate`; null on unauthenticated routes. */
    actor: Actor | null;
  }

  interface FastifyInstance {
    /** Authentication hook: verifies the Bearer access token and sets `request.actor`. */
    authenticate: onRequestAsyncHookHandler;
    /** Work that runs after the response (e.g. emailing a reset code); app.close() waits for it. */
    backgroundTasks: BackgroundTasks;
  }
}
