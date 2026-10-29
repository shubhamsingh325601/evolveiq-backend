// Zod schemas for class attendance (client feedback, 29 Oct 2026: "present days on the student
// card, 18/26 days"). One record per student per Asia/Kolkata day: present, late or absent.
import { z } from 'zod';
import { AttendanceStatus } from '../../generated/prisma/enums.js';

export { AttendanceStatus };

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
export const DaySchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'must be YYYY-MM-DD')
  .meta({ example: '2026-10-29' });

/** How far back a register can be taken or corrected. */
export const BACKFILL_DAYS = 30;
/** The longest span one read covers (about two months). */
export const MAX_RANGE_DAYS = 62;

export const ClassIdParamsSchema = z.strictObject({ classId: Uuid.meta({ description: 'Class ID (UUID).' }) });
export const ClassDayParamsSchema = z.strictObject({ classId: Uuid, day: DaySchema.meta({ description: 'Asia/Kolkata calendar day.' }) });

export const AttendanceQuerySchema = z.strictObject({
  from: DaySchema.optional().meta({ description: 'First day (default: the first of the month `to` is in).' }),
  to: DaySchema.optional().meta({ description: 'Last day (default: today, Asia/Kolkata).' }),
});
export type AttendanceQuery = z.output<typeof AttendanceQuerySchema>;

export const MarkAttendanceBodySchema = z
  .strictObject({
    records: z
      .array(z.strictObject({ studentId: Uuid, status: z.enum(AttendanceStatus) }))
      .min(1)
      .max(200)
      .refine((list) => new Set(list.map((r) => r.studentId)).size === list.length, 'must list each student once'),
  })
  .meta({ id: 'MarkAttendanceBody' });
export type MarkAttendanceBody = z.output<typeof MarkAttendanceBodySchema>;

export const ClassAttendanceSchema = z
  .object({
    classId: Id,
    from: DaySchema,
    to: DaySchema,
    days: z
      .array(
        z.object({
          day: DaySchema,
          markedBy: z.object({ fullName: z.string() }).nullable(),
          markedAt: z.iso.datetime(),
        }),
      )
      .meta({ description: 'Days the register was taken, oldest first.' }),
    students: z
      .array(
        z.object({
          id: Id,
          fullName: z.string(),
          present: z.number().int(),
          late: z.number().int(),
          absent: z.number().int(),
          records: z.record(z.string(), z.enum(AttendanceStatus)).meta({ description: 'Day -> status, for the days recorded.' }),
        }),
      )
      .meta({ description: 'The class as it is today, by name.' }),
  })
  .meta({ id: 'ClassAttendance' });
export type ClassAttendanceDto = z.output<typeof ClassAttendanceSchema>;

export const ClassAttendanceResponseSchema = z.object({ attendance: ClassAttendanceSchema }).meta({ id: 'ClassAttendanceResponse' });
