// JSON Schemas compiled once by Fastify's built-in Ajv. Validation happens before the
// handler runs, so no request reaches hashing or the database with malformed input.

// Non-blank, no control characters.
const fullName = {
  type: 'string', minLength: 1, maxLength: 100,
  pattern: '^[^\\u0000-\\u001F\\u007F]*[^\\s\\u0000-\\u001F\\u007F][^\\u0000-\\u001F\\u007F]*$',
};
const email = { type: 'string', format: 'email', maxLength: 254 };
// NIST SP 800-63B style: length over composition rules. Max bounds hashing cost.
const password = { type: 'string', minLength: 10, maxLength: 128 };
const studentId = { type: 'string', pattern: '^[A-Za-z0-9-]{3,32}$' };
const pin = { type: 'string', pattern: '^[0-9]{6}$' };
const uuid = { type: 'string', format: 'uuid' };

const adult = (role, { school }) => ({
  type: 'object',
  additionalProperties: false,
  required: ['role', 'fullName', 'email', 'password'],
  properties: {
    role: { const: role },
    fullName,
    email,
    password,
    ...(school ? { schoolId: uuid } : {}),
  },
});

export const registerSchema = {
  body: {
    type: 'object',
    required: ['role'],
    // Ajv discriminator: validates only the branch matching `role` → precise errors, no
    // wasted work on the other five branches.
    discriminator: { propertyName: 'role' },
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'fullName', 'studentId', 'pin'],
        properties: {
          role: { const: 'student' },
          fullName,
          studentId,
          pin,
          schoolId: uuid,
          parentId: uuid,
        },
      },
      adult('parent', { school: true }),
      adult('teacher', { school: true }),
      adult('school_admin', { school: true }),
      adult('psychologist', { school: false }),
      adult('platform_admin', { school: false }),
    ],
  },
  response: {
    201: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            role: { type: 'string' },
            fullName: { type: 'string' },
            schoolId: { type: ['string', 'null'] },
            parentId: { type: ['string', 'null'] },
            createdAt: { type: 'string' },
          },
        },
      },
    },
  },
};

// Login deliberately does NOT re-apply registration rules (length, PIN format): a policy
// change must never lock existing users out, and the verdict is always the hash check.
const loginField = { type: 'string', minLength: 1, maxLength: 256 };

export const loginSchema = {
  body: {
    type: 'object',
    oneOf: [
      {
        type: 'object', additionalProperties: false,
        required: ['email', 'password'],
        properties: { email: loginField, password: { type: 'string', minLength: 1, maxLength: 128 } },
      },
      {
        type: 'object', additionalProperties: false,
        required: ['studentId', 'pin'],
        properties: { studentId: loginField, pin: { type: 'string', minLength: 1, maxLength: 32 } },
      },
    ],
  },
  response: {
    200: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        tokenType: { type: 'string' },
        expiresIn: { type: 'integer' },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            role: { type: 'string' },
            fullName: { type: 'string' },
            schoolId: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
};
