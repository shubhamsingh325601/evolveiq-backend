// Zod schemas for parent ↔ student links — validated at the route boundary.
import { z } from 'zod';
import { PAGE_QUERY_FIELDS, PaginationSchema } from '../../shared/pagination/index.js';

const Uuid = z.guid();

export const CreateParentStudentBodySchema = z
  .strictObject({
    parentId: Uuid.meta({ description: 'An active parent in the same school as the student.' }),
    studentId: Uuid.meta({ description: 'A student without a parent yet.' }),
  })
  .meta({ id: 'CreateParentStudentRequest' });

export type CreateParentStudentBody = z.output<typeof CreateParentStudentBodySchema>;

export const StudentIdParamsSchema = z.strictObject({
  studentId: Uuid.meta({ description: 'Student user ID (UUID).' }),
});

export const ListParentStudentsQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  parentId: Uuid.optional().meta({ description: 'Only links of this parent.' }),
  studentId: Uuid.optional().meta({ description: 'Only the link of this student.' }),
});

export type ListParentStudentsQuery = z.output<typeof ListParentStudentsQuerySchema>;

const PersonSchema = z.object({ id: z.string().meta({ format: 'uuid' }), fullName: z.string() });

export const ParentStudentSchema = z
  .object({ parent: PersonSchema, student: PersonSchema, createdAt: z.iso.datetime() })
  .meta({ id: 'ParentStudent' });

export type ParentStudentDto = z.output<typeof ParentStudentSchema>;

export const ParentStudentResponseSchema = z.object({ link: ParentStudentSchema }).meta({ id: 'ParentStudentResponse' });

export const ParentStudentListResponseSchema = z
  .object({ links: z.array(ParentStudentSchema), pagination: PaginationSchema })
  .meta({ id: 'ParentStudentListResponse' });
