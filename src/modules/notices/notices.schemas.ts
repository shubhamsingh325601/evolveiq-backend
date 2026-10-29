// Zod schemas for the notice board (client feedback, 29 Oct 2026): "Events, activities,
// trainings, government policies and updates, emergency contacts". A School Admin posts for
// their school; a Platform Admin for one school or for every school.
import { z } from 'zod';
import { NoticeAudience, NoticeCategory } from '../../generated/prisma/enums.js';
import { PAGE_QUERY_FIELDS, PaginationSchema } from '../../shared/pagination/index.js';
import { PhoneSchema } from '../health/health.schemas.js';

export { NoticeAudience, NoticeCategory };

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
const Day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD');
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;
const freeText = (max: number) => z.string().max(max).regex(FREE_TEXT, 'must not be blank or contain control characters');

export const NoticeIdParamsSchema = z.strictObject({ noticeId: Uuid });

export const ListNoticesQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  category: z.enum(NoticeCategory).optional(),
  schoolId: Uuid.optional().meta({ description: 'Platform Admins only: one school’s notices.' }),
});
export type ListNoticesQuery = z.output<typeof ListNoticesQuerySchema>;

const fields = {
  category: z.enum(NoticeCategory),
  title: freeText(120),
  body: freeText(2000).meta({ description: 'The details, in plain words.' }),
  startsOn: Day.meta({ description: 'When an event, activity or training happens.' }),
  location: freeText(120),
  phone: PhoneSchema.meta({ description: 'Required for an emergency contact.' }),
  audience: z.enum(NoticeAudience).meta({ description: 'everyone, staff only, or families (parents and students). Admins always see every notice.' }),
  isPinned: z.boolean().meta({ description: 'Pinned notices come first.' }),
};

export const CreateNoticeBodySchema = z
  .strictObject({
    category: fields.category,
    title: fields.title,
    body: fields.body.optional(),
    startsOn: fields.startsOn.optional(),
    location: fields.location.optional(),
    phone: fields.phone.optional(),
    audience: fields.audience.default('everyone'),
    isPinned: fields.isPinned.default(false),
    schoolId: Uuid.optional().meta({
      description: 'Platform Admins: the school, or leave it out for every school. School Admins: always their own.',
    }),
  })
  .meta({ id: 'CreateNoticeBody' });
export type CreateNoticeBody = z.output<typeof CreateNoticeBodySchema>;

export const UpdateNoticeBodySchema = z
  .strictObject({
    category: fields.category.optional(),
    title: fields.title.optional(),
    body: fields.body.nullable().optional(),
    startsOn: fields.startsOn.nullable().optional(),
    location: fields.location.nullable().optional(),
    phone: fields.phone.nullable().optional(),
    audience: fields.audience.optional(),
    isPinned: fields.isPinned.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'send at least one field to change')
  .meta({ id: 'UpdateNoticeBody', description: 'null clears an optional field.' });
export type UpdateNoticeBody = z.output<typeof UpdateNoticeBodySchema>;

export const NoticeSchema = z
  .object({
    id: Id,
    schoolId: Id.nullable().meta({ description: 'Null: posted for every school.' }),
    schoolName: z.string().nullable(),
    category: z.enum(NoticeCategory),
    title: z.string(),
    body: z.string().nullable(),
    startsOn: Day.nullable(),
    location: z.string().nullable(),
    phone: z.string().nullable(),
    audience: z.enum(NoticeAudience),
    isPinned: z.boolean(),
    createdBy: z.object({ fullName: z.string() }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    canManage: z.boolean().meta({ description: 'Whether the caller may edit or delete it.' }),
  })
  .meta({ id: 'Notice' });
export type NoticeDto = z.output<typeof NoticeSchema>;

export const NoticeResponseSchema = z.object({ notice: NoticeSchema }).meta({ id: 'NoticeResponse' });
export const NoticeListResponseSchema = z
  .object({ notices: z.array(NoticeSchema).meta({ description: 'Pinned first, then newest first.' }), pagination: PaginationSchema })
  .meta({ id: 'NoticeListResponse' });
