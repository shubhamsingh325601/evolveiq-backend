// Business rules for progress. No HTTP, no SQL.
//
// Who: the student themselves, their parent, their teachers (class scope) and psychologists —
//   the shared student scope (users/student-scope.ts); anyone else's student → 404.
// Growth areas: DERIVED, never entered — the development areas of the student's "Assign & mark
//   reviewed" reviews, the 5 most recent (distinct) ones; older ones drop off.
// Streak: consecutive Asia/Kolkata days with ≥ 1 completion, counting from yesterday when
//   today has none yet.
// Monthly summary: plain template sentences (no AI). The current month is built live on each
//   request; a finished month is stored the first time it is requested and never changes.
import type { DevelopmentArea } from '../../generated/prisma/enums.js';
import { Errors } from '../../shared/errors/index.js';
import type { Actor } from '../../shared/rbac/index.js';
import { DEVELOPMENT_AREA_LABELS } from '../observations/observation-options.js';
import type { StudentScopeRepository } from '../users/student-scope.js';
import { businessDate, businessMonth, currentStreak, longestRun, monthBounds, monthLabel } from './business-time.js';
import type { ProgressRepository } from './progress.repository.js';

export interface SummaryFacts {
  readonly name: string;
  readonly month: string;
  readonly isCurrentMonth: boolean;
  readonly completed: number;
  readonly activeDays: number;
  readonly longestStreak: number;
  readonly growthAreas: readonly string[];
}

function list(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The plain-language, parent-safe summary. Only counts and growth-area names go in. */
export function buildSummaryText(f: SummaryFacts): string {
  const label = monthLabel(f.month);
  const sentences: string[] = [];
  if (f.completed === 0) {
    sentences.push(
      f.isCurrentMonth
        ? `${f.name} has not completed any activities yet in ${label}.`
        : `${f.name} did not complete any activities in ${label}.`,
    );
  } else {
    const done = `${plural(f.completed, 'activity', 'activities')} on ${plural(f.activeDays, 'day', 'different days')}`;
    sentences.push(f.isCurrentMonth ? `So far in ${label}, ${f.name} has completed ${done}.` : `In ${label}, ${f.name} completed ${done}.`);
    if (f.longestStreak >= 2) sentences.push(`Their longest streak was ${f.longestStreak} days in a row.`);
  }
  if (f.growthAreas.length > 0) sentences.push(`Areas ${f.name} is working on: ${list(f.growthAreas)}.`);
  return sentences.join(' ');
}

const namesOf = (areas: readonly DevelopmentArea[]) => areas.map((area) => DEVELOPMENT_AREA_LABELS[area]);

export function createProgressService(deps: { repository: ProgressRepository; students: StudentScopeRepository; now: () => Date }) {
  const { repository, students, now } = deps;

  async function studentInScope(actor: Actor, studentId: string) {
    const student = await students.findStudent(actor, studentId);
    if (!student) throw Errors.notFound('Student');
    return student;
  }

  async function growthAreas(actor: Actor, studentId: string): Promise<{ growthAreas: { name: string }[] }> {
    const student = await studentInScope(actor, studentId);
    const areas = await repository.growthAreas(student.id, now());
    return { growthAreas: namesOf(areas).slice(0, 5).map((name) => ({ name })) };
  }

  async function streak(actor: Actor, studentId: string): Promise<{ streak: { days: number } }> {
    const student = await studentInScope(actor, studentId);
    const at = now();
    const days = await repository.completionDays(student.id, at);
    return { streak: { days: currentStreak(days, businessDate(at)) } };
  }

  async function monthlySummary(actor: Actor, studentId: string, month: string) {
    const student = await studentInScope(actor, studentId);
    const at = now();
    const currentMonth = businessMonth(at);
    if (month > currentMonth) throw Errors.validation([{ field: 'month', message: 'must not be in the future' }]);
    if (month < businessMonth(student.createdAt)) throw Errors.notFound('Monthly summary');

    const bounds = monthBounds(month);
    const isCurrentMonth = month === currentMonth;
    const build = async () => {
      const [activity, areas] = await Promise.all([
        repository.monthActivity(student.id, bounds, at),
        repository.growthAreas(student.id, at, isCurrentMonth ? undefined : bounds.nextFirst),
      ]);
      return buildSummaryText({
        name: student.fullName,
        month,
        isCurrentMonth,
        completed: activity.completed,
        activeDays: activity.days.length,
        longestStreak: longestRun(activity.days),
        growthAreas: namesOf(areas),
      });
    };

    let text: string;
    if (isCurrentMonth) {
      text = await build(); // live, never stored
    } else {
      const stored = await repository.findSummary(student.id, bounds.first);
      if (stored !== null) {
        text = stored;
      } else {
        // First request after the month ended: store it. A concurrent first request may win
        // the insert; either way the stored row is what everyone gets from now on.
        await repository.insertSummary(student.id, bounds.first, await build());
        const winner = await repository.findSummary(student.id, bounds.first);
        if (winner === null) throw new Error('monthlySummary: stored summary not found');
        text = winner;
      }
    }
    return { summary: { studentId: student.id, month, text, isFinal: !isCurrentMonth } };
  }

  return { growthAreas, streak, monthlySummary };
}

export type ProgressService = ReturnType<typeof createProgressService>;
