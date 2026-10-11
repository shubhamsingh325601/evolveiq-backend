// Zod schemas for the auth routes (validated at the route boundary by Fastify, before the
// handler runs, so no request reaches hashing or the database with malformed input).
// These reproduce the rules of the previous Ajv JSON schemas one-for-one.
import { z } from 'zod';
import { ROLES } from '../../shared/rbac/index.js';

// Non-blank, no control characters.
const FULL_NAME = /^[^\u0000-\u001F\u007F]*[^\s\u0000-\u001F\u007F][^\u0000-\u001F\u007F]*$/u;
// The exact "email" format the previous Ajv validation used (ajv-formats, full mode).
const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

const FullNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(FULL_NAME, 'must not be blank or contain control characters')
  .meta({ example: 'Kavya S' });
const EmailSchema = z
  .string()
  .max(254)
  .regex(EMAIL, 'must be a valid email address')
  .meta({ format: 'email', example: 'kavya@school-a.test' });
// NIST SP 800-63B style: length over composition rules. Max bounds hashing cost.
const PasswordSchema = z.string().min(10).max(128).meta({ example: 'Correct-Horse-1' });
const StudentIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{3,32}$/, 'must be 3–32 letters, digits or hyphens')
  .meta({ example: 'A-1001' });
const PinSchema = z.string().regex(/^[0-9]{6}$/, 'must be exactly 6 digits').meta({ example: '482913' });
// Any 8-4-4-4-12 hex UUID (same as the previous Ajv "uuid" format).
const UuidSchema = z.guid();

const adult = <R extends 'parent' | 'teacher' | 'school_admin'>(role: R) =>
  z.strictObject({
    role: z.literal(role),
    fullName: FullNameSchema,
    email: EmailSchema,
    password: PasswordSchema,
    schoolId: UuidSchema.optional(),
  });
const platformLevel = <R extends 'psychologist' | 'platform_admin'>(role: R) =>
  z.strictObject({
    role: z.literal(role),
    fullName: FullNameSchema,
    email: EmailSchema,
    password: PasswordSchema,
  });

export const RegisterBodySchema = z
  .discriminatedUnion(
    'role',
    [
      z.strictObject({
        role: z.literal('student'),
        fullName: FullNameSchema,
        studentId: StudentIdSchema,
        pin: PinSchema,
        schoolId: UuidSchema.optional(),
        parentId: UuidSchema.optional(),
      }),
      adult('parent'),
      adult('teacher'),
      adult('school_admin'),
      platformLevel('psychologist'),
      platformLevel('platform_admin'),
    ],
    { error: `must be one of: ${ROLES.join(', ')}` },
  )
  .meta({ id: 'RegisterRequest' });

export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const RegisteredUserSchema = z
  .object({
    id: z.string(),
    role: z.string(),
    fullName: z.string(),
    schoolId: z.string().nullable(),
    parentId: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'RegisteredUser' });

// Login deliberately does NOT re-apply registration rules (length, PIN format): a policy
// change must never lock existing users out, and the verdict is always the hash check.
const LoginFieldSchema = z.string().min(1).max(256);

export const LoginBodySchema = z
  .union([
    z.strictObject({ email: LoginFieldSchema, password: z.string().min(1).max(128) }),
    z.strictObject({ studentId: LoginFieldSchema, pin: z.string().min(1).max(32) }),
  ])
  .meta({ id: 'LoginRequest' });

export type LoginBody = z.infer<typeof LoginBodySchema>;

const TOKEN_FIELDS = {
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().meta({ description: 'Access-token lifetime in seconds.' }),
  refreshToken: z.string(),
  refreshExpiresIn: z.number().int().meta({ description: 'Refresh-token lifetime in seconds.' }),
};

export const LoginResponseSchema = z
  .object({
    ...TOKEN_FIELDS,
    user: z.object({
      id: z.string(),
      role: z.string(),
      fullName: z.string(),
      schoolId: z.string().nullable(),
    }),
  })
  .meta({ id: 'LoginResponse' });

export const RefreshBodySchema = z
  .strictObject({ refreshToken: z.string().min(1).max(2048) })
  .meta({ id: 'RefreshRequest' });

export const RefreshResponseSchema = z.object(TOKEN_FIELDS).meta({ id: 'TokenResponse' });
