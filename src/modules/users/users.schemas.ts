// Zod schemas for the user-management routes — validated at the route boundary.
import { z } from 'zod';
import { PAGE_QUERY_FIELDS, PaginationSchema, SORT_ORDERS } from '../../shared/pagination/index.js';
import { Role } from '../../shared/rbac/index.js';
import { EmailSchema, FullNameSchema, StudentIdSchema } from '../auth/auth.schemas.js';

export const UserIdParamsSchema = z.strictObject({
  userId: z.guid().meta({ description: 'User ID (UUID).', example: 'df7e2c1a-4b6d-4f3e-9a1b-2c3d4e5f6a7b' }),
});

// ---------- Edit ----------
// Same field rules as registration. Adults may change fullName/email, students
// fullName/studentId (checked against the target's role by the service). Role, school,
// parent, active flag and secrets are not editable here: unknown fields are rejected (400).
export const UpdateUserBodySchema = z
  .strictObject({
    fullName: FullNameSchema.optional(),
    email: EmailSchema.optional(),
    studentId: StudentIdSchema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to change.',
  })
  .meta({ id: 'UpdateUserRequest' });

export type UpdateUserBody = z.output<typeof UpdateUserBodySchema>;

// ---------- List query ----------
/** Sortable fields — an allowlist. Nothing outside it can reach the ORDER BY. */
export const USER_SORT_FIELDS = ['fullName', 'createdAt'] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export const ListUsersQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  sortBy: z
    .enum(USER_SORT_FIELDS)
    .default('fullName')
    .meta({ description: 'Field to sort by (default "fullName"). Ties are broken by id.' }),
  sortOrder: z.enum(SORT_ORDERS).default('asc').meta({ description: 'Sort direction (default "asc").' }),
  role: z.enum(Role).optional().meta({ description: 'Only users with this role.' }),
  schoolId: z.guid().optional().meta({ description: 'Only users in this school.' }),
  isActive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .meta({ description: '"true" = active users only, "false" = deactivated users only.' }),
  name: z
    .string()
    .max(100)
    .transform((value) => value.trim() || undefined)
    .optional()
    .meta({ description: 'Case-insensitive "contains" filter on the full name. Empty = no filter.' }),
});

export type ListUsersQuery = z.output<typeof ListUsersQuerySchema>;

// ---------- Responses ----------
// Login secrets, lockout counters and other internals are never part of this shape; the
// serializer drops anything not declared here.
export const UserSchema = z
  .object({
    id: z.string().meta({ format: 'uuid' }),
    role: z.enum(Role),
    fullName: z.string(),
    email: z.string().nullable().meta({ description: 'Adults only; null for students.' }),
    studentId: z.string().nullable().meta({ description: 'Students only; null for adults.' }),
    schoolId: z.string().nullable().meta({ description: 'Null for Psychologists and Platform Admins.' }),
    parentId: z.string().nullable().meta({ description: "Students only: the linked parent's user ID." }),
    isActive: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'User' });

export type UserDto = z.output<typeof UserSchema>;

export const UserResponseSchema = z.object({ user: UserSchema }).meta({ id: 'UserResponse' });

export const UserListResponseSchema = z
  .object({ users: z.array(UserSchema), pagination: PaginationSchema })
  .meta({ id: 'UserListResponse' });
