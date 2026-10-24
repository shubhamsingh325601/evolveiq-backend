// HTTP layer only: validation (Zod), RBAC wiring, status codes.
//
//   GET  /api/v1/notifications        the caller's feed and how many are unread
//   POST /api/v1/notifications/seen   mark everything read
//
// Students and parents hear only good news and activities. Teachers hear when their students
// finish activities; psychologists hear how many observations await review.
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../shared/db/prisma.js';
import { errorResponses } from '../../shared/errors/index.js';
import { actorOf, describeRoles, requireRole, Role } from '../../shared/rbac/index.js';
import { buildFeed, countUnread } from './notifications.js';
import { createNotificationsRepository } from './notifications.repository.js';

export interface NotificationsRoutesOptions {
  db: Db;
  now: () => Date;
}

const Id = z.string().meta({ format: 'uuid' });

const NotificationSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['star', 'activity_assigned', 'activity_finished', 'review_queue']),
    title: z.string(),
    body: z.string(),
    studentId: Id.nullable(),
    at: z.iso.datetime(),
    isUnread: z.boolean(),
  })
  .meta({ id: 'Notification' });

const NotificationsResponseSchema = z
  .object({ notifications: z.array(NotificationSchema).meta({ description: 'Newest first, at most 30.' }), unreadCount: z.number().int() })
  .meta({ id: 'NotificationsResponse' });

const SeenResponseSchema = z.object({ seenAt: z.iso.datetime() }).meta({ id: 'NotificationsSeenResponse' });

const notificationsRoutes: FastifyPluginAsyncZod<NotificationsRoutesOptions> = async (app, { db, now }) => {
  const repository = createNotificationsRepository(db);
  const viewers = requireRole(Role.Student, Role.Parent, Role.Teacher, Role.Psychologist);
  const docs = { tags: ['Notifications'], security: [{ bearerAuth: [] }] };

  app.get('', {
    onRequest: [app.authenticate, viewers],
    schema: {
      ...docs,
      summary: 'My notifications',
      description: `${describeRoles(viewers.allowedRoles)} Derived from what already happened, newest first. Unread means newer than the last time the feed was marked seen.`,
      response: { 200: NotificationsResponseSchema, ...errorResponses(401, 403, 500) },
    },
    handler: async (request) => {
      const actor = actorOf(request);
      const [inputs, seenAt] = await Promise.all([repository.inputs(actor), repository.seenAt(actor.userId)]);
      const items = buildFeed(actor, inputs);
      return {
        notifications: items.map((item) => ({
          ...item,
          at: item.at.toISOString(),
          isUnread: seenAt === null || item.at.getTime() > seenAt.getTime(),
        })),
        unreadCount: countUnread(items, seenAt),
      };
    },
  });

  app.post('/seen', {
    onRequest: [app.authenticate, viewers],
    schema: {
      ...docs,
      summary: 'Mark my notifications as seen',
      description: describeRoles(viewers.allowedRoles),
      response: { 200: SeenResponseSchema, ...errorResponses(401, 403, 500) },
    },
    handler: async (request) => {
      const at = now();
      await repository.markSeen(actorOf(request).userId, at);
      return { seenAt: at.toISOString() };
    },
  });
};

export default notificationsRoutes;
