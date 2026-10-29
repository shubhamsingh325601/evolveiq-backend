// Business rules for class attendance. No HTTP, no SQL.
//
// Who: a class's own teachers and the School Admin of its school (class-scope.ts); a class
//   outside that scope is reported as missing.
// What: one status per student per Asia/Kolkata day — present, late or absent. "Days present"
//   counts present and late; the days a register was taken are the school days.
// When: today, or a correction up to BACKFILL_DAYS back. Never a future day.
import { Errors } from '../../shared/errors/index.js';
import type { Actor } from '../../shared/rbac/index.js';
import { businessDate } from '../progress/business-time.js';
import type { ClassScopeRepository } from '../schools/class-scope.js';
import type { AttendanceRepository } from './attendance.repository.js';
import {
  BACKFILL_DAYS,
  MAX_RANGE_DAYS,
  type AttendanceQuery,
  type AttendanceStatus,
  type ClassAttendanceDto,
  type MarkAttendanceBody,
} from './attendance.schemas.js';

const DAY_MS = 86_400_000;
const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => dayOf(new Date(asDate(day).getTime() + days * DAY_MS));
const span = (from: string, to: string) => Math.round((asDate(to).getTime() - asDate(from).getTime()) / DAY_MS) + 1;

export function createAttendanceService(deps: { repository: AttendanceRepository; classes: ClassScopeRepository; now: () => Date }) {
  const { repository, classes, now } = deps;

  async function requireClass(actor: Actor, classId: string): Promise<void> {
    if (!(await classes.findClass(actor, classId))) throw Errors.notFound('Class');
  }

  async function read(classId: string, from: string, to: string): Promise<ClassAttendanceDto> {
    const members = await classes.students(classId);
    const rows = await repository.between(
      members.map((m) => m.id),
      asDate(from),
      asDate(to),
    );

    const byDay = new Map<string, { markedBy: { fullName: string } | null; markedAt: Date }>();
    const byStudent = new Map<string, Record<string, AttendanceStatus>>();
    for (const row of rows) {
      const day = dayOf(row.day);
      const seen = byDay.get(day);
      // The day's register is "taken" by whoever saved last.
      if (!seen || row.updatedAt > seen.markedAt) byDay.set(day, { markedBy: { fullName: row.markedBy.fullName }, markedAt: row.updatedAt });
      const records = byStudent.get(row.studentId) ?? {};
      records[day] = row.status;
      byStudent.set(row.studentId, records);
    }

    return {
      classId,
      from,
      to,
      days: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, { markedBy, markedAt }]) => ({ day, markedBy, markedAt: markedAt.toISOString() })),
      students: members.map((member) => {
        const records = byStudent.get(member.id) ?? {};
        const statuses = Object.values(records);
        return {
          id: member.id,
          fullName: member.fullName,
          present: statuses.filter((s) => s === 'present').length,
          late: statuses.filter((s) => s === 'late').length,
          absent: statuses.filter((s) => s === 'absent').length,
          records,
        };
      }),
    };
  }

  async function forClass(actor: Actor, classId: string, query: AttendanceQuery): Promise<ClassAttendanceDto> {
    await requireClass(actor, classId);
    const today = businessDate(now());
    const to = query.to ?? today;
    const from = query.from ?? `${to.slice(0, 7)}-01`;
    if (to > today) throw Errors.validation([{ field: 'to', message: 'must not be in the future' }]);
    if (from > to) throw Errors.validation([{ field: 'from', message: 'must not be after "to"' }]);
    if (span(from, to) > MAX_RANGE_DAYS) {
      throw Errors.validation([{ field: 'from', message: `must be at most ${MAX_RANGE_DAYS} days before "to"` }]);
    }
    return read(classId, from, to);
  }

  async function mark(actor: Actor, classId: string, day: string, body: MarkAttendanceBody): Promise<ClassAttendanceDto> {
    await requireClass(actor, classId);
    const today = businessDate(now());
    if (day > today) throw Errors.validation([{ field: 'day', message: 'must not be in the future' }]);
    if (day < addDays(today, -BACKFILL_DAYS)) {
      throw Errors.validation([{ field: 'day', message: `must be today or one of the last ${BACKFILL_DAYS} days` }]);
    }
    const members = new Set((await classes.students(classId)).map((m) => m.id));
    if (body.records.some((record) => !members.has(record.studentId))) {
      throw Errors.invalidReference('records', 'Every student must be in this class.');
    }
    await repository.mark(asDate(day), actor.userId, body.records);
    return read(classId, day, day);
  }

  return { forClass, mark };
}

export type AttendanceService = ReturnType<typeof createAttendanceService>;
