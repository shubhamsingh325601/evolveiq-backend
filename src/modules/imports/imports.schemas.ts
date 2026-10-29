// Zod schemas for importing people from a spreadsheet (client feedback, 29 Oct 2026: "add
// school data by importing… manual feed"). The frontend reads the CSV; this endpoint checks
// every row and, when every row is fine and it is not a dry run, creates them all at once.
//
// Rows arrive loosely typed on purpose: a missing or malformed cell is reported against its row
// in plain words, instead of failing the whole request on the first bad cell.
import { z } from 'zod';

const Uuid = z.guid();
const cell = (max = 500) => z.string().max(max).optional();
const list = () => z.array(z.string().max(200)).max(30).optional();

/** One request at most; a bigger file is imported in parts. */
export const MAX_IMPORT_ROWS = 500;

const StudentRowSchema = z.strictObject({
  fullName: cell(),
  studentId: cell(),
  pin: cell(),
  className: cell().meta({ description: 'An existing class (any case) or a new one, created by the import.' }),
  parentEmail: cell().meta({ description: 'A parent already at the school, to link.' }),
});
const TeacherRowSchema = z.strictObject({
  fullName: cell(),
  email: cell(),
  password: cell(),
  classNames: list().meta({ description: 'Classes they teach: existing or new.' }),
});
const ParentRowSchema = z.strictObject({
  fullName: cell(),
  email: cell(),
  password: cell(),
  childStudentIds: list().meta({ description: 'Student IDs of their children, already at the school and without a parent.' }),
});

const common = {
  schoolId: Uuid.optional().meta({ description: 'Platform Admins: required. School Admins: their own school, always.' }),
  dryRun: z.boolean().default(true).meta({ description: 'Check only (default). false: create, if every row is fine.' }),
};

export const ImportPeopleBodySchema = z
  .discriminatedUnion('role', [
    z.strictObject({ role: z.literal('student'), ...common, rows: z.array(StudentRowSchema).min(1).max(MAX_IMPORT_ROWS) }),
    z.strictObject({ role: z.literal('teacher'), ...common, rows: z.array(TeacherRowSchema).min(1).max(MAX_IMPORT_ROWS) }),
    z.strictObject({ role: z.literal('parent'), ...common, rows: z.array(ParentRowSchema).min(1).max(MAX_IMPORT_ROWS) }),
  ])
  .meta({ id: 'ImportPeopleBody' });
export type ImportPeopleBody = z.output<typeof ImportPeopleBodySchema>;
export type StudentRow = z.output<typeof StudentRowSchema>;
export type TeacherRow = z.output<typeof TeacherRowSchema>;
export type ParentRow = z.output<typeof ParentRowSchema>;

export const ImportReportSchema = z
  .object({
    role: z.enum(['student', 'teacher', 'parent']),
    dryRun: z.boolean(),
    isValid: z.boolean().meta({ description: 'Every row is fine.' }),
    created: z.number().int().meta({ description: 'Accounts created: 0 on a dry run, or when any row has a problem.' }),
    newClasses: z.array(z.string()).meta({ description: 'Classes the import creates (or would create).' }),
    rows: z.array(
      z.object({
        row: z.number().int().meta({ description: '1 = the first row after the header.' }),
        fullName: z.string(),
        identifier: z.string().meta({ description: 'Student ID or email address, as normalised.' }),
        problems: z.array(z.string()).meta({ description: 'Empty when the row is fine.' }),
      }),
    ),
  })
  .meta({ id: 'ImportReport' });
export type ImportReportDto = z.output<typeof ImportReportSchema>;
export const ImportReportResponseSchema = z.object({ report: ImportReportSchema }).meta({ id: 'ImportReportResponse' });
