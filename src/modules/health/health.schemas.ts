// Zod schemas for a student's health and care profile (client feedback, 29 Oct 2026): the
// conditions the school should know about, allergies, medication, care notes and an
// emergency contact. Written by the family or the School Admin; read by school staff.
import { z } from 'zod';
import { HealthCondition } from '../../generated/prisma/enums.js';

export { HealthCondition };

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;
const freeText = (max: number) => z.string().max(max).regex(FREE_TEXT, 'must not be blank or contain control characters');

/** Digits with optional +, spaces, brackets and hyphens: "112", "+91 98450 12345", "(080) 4000-1234". */
export const PhoneSchema = z
  .string()
  .min(3)
  .max(20)
  .regex(/^\+?[0-9][0-9 ()-]*[0-9]$/, 'must be a phone number')
  .meta({ example: '+91 98450 12345' });

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

/** In the client's own words where they gave them ("Diabetic", "Specially abled"…). */
export const HEALTH_CONDITION_LABELS: Readonly<Record<HealthCondition, string>> = Object.freeze({
  diabetes: 'Diabetes',
  asthma: 'Asthma',
  epilepsy: 'Epilepsy / seizures',
  severe_allergy: 'Severe allergy',
  on_medication: 'On medication',
  specially_abled: 'Specially abled',
  visual_impairment: 'Visually impaired',
  hearing_impairment: 'Hearing impaired',
  dyslexia: 'Dyslexia',
  adhd: 'ADHD',
  autism: 'Autism',
  speech_language: 'Speech and language',
  other: 'Other',
});

export const StudentIdParamsSchema = z.strictObject({ studentId: Uuid.meta({ description: 'Student user ID (UUID).' }) });
export const ClassIdParamsSchema = z.strictObject({ classId: Uuid.meta({ description: 'Class ID (UUID).' }) });

const EmergencyContactBodySchema = z.strictObject({
  name: freeText(100),
  relation: freeText(50).optional().meta({ description: 'e.g. "Mother", "Uncle".' }),
  phone: PhoneSchema,
});

export const PutHealthBodySchema = z
  .strictObject({
    conditions: z
      .array(z.enum(HealthCondition))
      .max(Object.keys(HEALTH_CONDITION_LABELS).length)
      .refine((list) => new Set(list).size === list.length, 'must not repeat a condition')
      .meta({ description: 'Every condition that applies; [] for none.' }),
    bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
    allergies: freeText(500).nullable().optional(),
    medications: freeText(500).nullable().optional().meta({ description: 'What, how much and when, if the school gives any.' }),
    careNotes: freeText(1000).nullable().optional().meta({ description: 'What the school should do, in plain words.' }),
    emergencyContact: EmergencyContactBodySchema.nullable().optional(),
  })
  .meta({
    id: 'PutHealthProfileBody',
    description: 'Replaces the whole profile: a field left out is cleared.',
  });
export type PutHealthBody = z.output<typeof PutHealthBodySchema>;

export const HealthProfileSchema = z
  .object({
    studentId: Id,
    conditions: z.array(z.enum(HealthCondition)),
    bloodGroup: z.enum(BLOOD_GROUPS).nullable(),
    allergies: z.string().nullable(),
    medications: z.string().nullable(),
    careNotes: z.string().nullable(),
    emergencyContact: z.object({ name: z.string(), relation: z.string().nullable(), phone: z.string() }).nullable(),
    updatedBy: z
      .object({ fullName: z.string(), role: z.string() })
      .nullable()
      .meta({ description: 'Who last changed it; null if never recorded or that account is gone.' }),
    updatedAt: z.iso.datetime().nullable().meta({ description: 'Null when nothing has been recorded yet.' }),
  })
  .meta({ id: 'HealthProfile' });
export type HealthProfileDto = z.output<typeof HealthProfileSchema>;

export const HealthProfileResponseSchema = z.object({ health: HealthProfileSchema }).meta({ id: 'HealthProfileResponse' });
export const ClassHealthResponseSchema = z
  .object({ profiles: z.array(HealthProfileSchema).meta({ description: 'Only students with something recorded, by name.' }) })
  .meta({ id: 'ClassHealthResponse' });
