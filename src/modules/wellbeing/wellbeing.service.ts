// Business rules for family consent and wellbeing check-ins. No HTTP, no SQL.
//
// Consent: only a parent decides, for their own child. No decision means "no". A student can
//   read where they stand; nobody else can.
// Check-ins: the student, or their parent, records one per day (mood and energy 1-5, sleep and
//   active minutes optional) once the family has allowed tracking. A second one for the same day
//   replaces the first. Teachers and the counsellor see them only when the family has also allowed
//   sharing with the school; otherwise they get an empty, clearly marked answer.
// Nothing here is clinical, and nothing here feeds the Holistic Index.
import { AppError, Errors } from '../../shared/errors/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import { businessDate } from '../progress/business-time.js';
import type { StudentScopeRepository } from '../users/student-scope.js';
import type { CheckinRecord, WellbeingRepository } from './wellbeing.repository.js';
import {
  CONSENT_PURPOSE_LABELS,
  ConsentPurpose,
  type CheckinBody,
  type CheckinDto,
  type CheckinsQuery,
  type CheckinsResponse,
  type ConsentDto,
} from './wellbeing.schemas.js';
import { isRecordableDay, summariseCheckins, windowStart } from './wellness.js';

const PURPOSES = Object.values(ConsentPurpose) as ConsentPurpose[];

const consentRequired = () =>
  new AppError(403, 'CONSENT_REQUIRED', 'A parent needs to allow wellbeing check-ins first (Privacy & safety).');

const toCheckinDto = (c: CheckinRecord): CheckinDto => ({
  day: c.day.toISOString().slice(0, 10),
  mood: c.mood,
  energy: c.energy,
  sleepMinutes: c.sleepMinutes,
  activeMinutes: c.activeMinutes,
});

export function createWellbeingService(deps: {
  repository: WellbeingRepository;
  students: StudentScopeRepository;
  now: () => Date;
}) {
  const { repository, students, now } = deps;

  async function requireStudent(actor: Actor, studentId: string): Promise<void> {
    if (!(await students.findStudent(actor, studentId))) throw Errors.notFound('Student');
  }

  async function consentState(studentId: string): Promise<{ list: ConsentDto[]; tracking: boolean; sharing: boolean }> {
    const records = new Map((await repository.consents(studentId)).map((r) => [r.purpose, r]));
    const list = PURPOSES.map((purpose): ConsentDto => {
      const record = records.get(purpose);
      return {
        purpose,
        label: CONSENT_PURPOSE_LABELS[purpose],
        granted: record?.granted ?? false,
        decidedAt: record?.decidedAt.toISOString() ?? null,
      };
    });
    const granted = (purpose: ConsentPurpose) => list.find((c) => c.purpose === purpose)?.granted ?? false;
    // Sharing only means something while tracking is on.
    const tracking = granted(ConsentPurpose.wellness_tracking);
    return { list, tracking, sharing: tracking && granted(ConsentPurpose.wellness_sharing) };
  }

  async function listConsents(actor: Actor, studentId: string): Promise<ConsentDto[]> {
    await requireStudent(actor, studentId);
    return (await consentState(studentId)).list;
  }

  async function setConsent(actor: Actor, studentId: string, purpose: ConsentPurpose, granted: boolean): Promise<ConsentDto> {
    if (actor.role !== Role.Parent) throw Errors.forbidden();
    await requireStudent(actor, studentId);
    const record = await repository.setConsent(studentId, purpose, granted, actor.userId);
    return {
      purpose,
      label: CONSENT_PURPOSE_LABELS[purpose],
      granted: record.granted,
      decidedAt: record.decidedAt.toISOString(),
    };
  }

  async function recordCheckin(actor: Actor, studentId: string, body: CheckinBody): Promise<CheckinDto> {
    if (actor.role !== Role.Student && actor.role !== Role.Parent) throw Errors.forbidden();
    await requireStudent(actor, studentId);
    if (!(await consentState(studentId)).tracking) throw consentRequired();

    const today = businessDate(now());
    const day = body.day ?? today;
    if (!isRecordableDay(day, today)) {
      throw Errors.validation([{ field: 'day', message: 'must be today or one of the last 30 days' }]);
    }
    const saved = await repository.saveCheckin(studentId, actor.userId, day, {
      mood: body.mood,
      energy: body.energy,
      sleepMinutes: body.sleepMinutes ?? null,
      activeMinutes: body.activeMinutes ?? null,
    });
    return toCheckinDto(saved);
  }

  async function listCheckins(actor: Actor, studentId: string, query: CheckinsQuery): Promise<CheckinsResponse> {
    await requireStudent(actor, studentId);
    const state = await consentState(studentId);
    const isFamily = actor.role === Role.Student || actor.role === Role.Parent;
    const isVisible = state.tracking && (isFamily || state.sharing);
    const checkins = isVisible
      ? (await repository.checkins(studentId, windowStart(businessDate(now()), query.days))).map(toCheckinDto)
      : [];
    return {
      isTracking: state.tracking,
      isSharedWithSchool: state.sharing,
      isVisible,
      checkins,
      summary: summariseCheckins(checkins),
    };
  }

  return { listConsents, setConsent, recordCheckin, listCheckins };
}

export type WellbeingService = ReturnType<typeof createWellbeingService>;
