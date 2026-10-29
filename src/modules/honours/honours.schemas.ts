// Zod schemas for the celebration wall (client feedback, 29 Oct 2026): "promote staff on the
// wall — best Staff of the Month", and "similar celebration for students".
import { z } from 'zod';
import { HonourKind } from '../../generated/prisma/enums.js';
import { PAGE_QUERY_FIELDS, PaginationSchema } from '../../shared/pagination/index.js';
import { MonthSchema } from '../staff/staff-reviews.schemas.js';

export { HonourKind };

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;

export const HonourIdParamsSchema = z.strictObject({ honourId: Uuid });

export const ListHonoursQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  month: MonthSchema.optional(),
  kind: z.enum(HonourKind).optional(),
  schoolId: Uuid.optional().meta({ description: 'Platform Admins only: one school’s wall.' }),
});
export type ListHonoursQuery = z.output<typeof ListHonoursQuerySchema>;

export const CreateHonourBodySchema = z
  .strictObject({
    kind: z.enum(HonourKind),
    month: MonthSchema,
    honoreeId: Uuid.meta({ description: 'A teacher (Staff of the Month) or a student (Student of the Month) of the school.' }),
    citation: z
      .string()
      .max(500)
      .regex(FREE_TEXT, 'must not be blank or contain control characters')
      .meta({ description: 'Why, in a sentence or two. Shown on the wall.' }),
  })
  .meta({ id: 'CreateHonourBody' });
export type CreateHonourBody = z.output<typeof CreateHonourBodySchema>;

export const HonourSchema = z
  .object({
    id: Id,
    kind: z.enum(HonourKind),
    month: MonthSchema,
    honoree: z.object({
      id: Id,
      fullName: z.string(),
      role: z.enum(['teacher', 'student']),
      className: z.string().nullable().meta({ description: 'A student’s class; null for staff.' }),
    }),
    citation: z.string(),
    awardedBy: z.object({ fullName: z.string() }),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Honour' });
export type HonourDto = z.output<typeof HonourSchema>;

export const HonourResponseSchema = z.object({ honour: HonourSchema }).meta({ id: 'HonourResponse' });
export const HonourListResponseSchema = z
  .object({ honours: z.array(HonourSchema).meta({ description: 'Newest month first.' }), pagination: PaginationSchema })
  .meta({ id: 'HonourListResponse' });
