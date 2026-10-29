// Business rules for importing people. No HTTP, no SQL.
//
// Who: a School Admin into their own school; a Platform Admin into the school they name.
// What: students (name, student ID, PIN, class, parent's email), teachers (name, email,
//   password, classes) or parents (name, email, password, children's student IDs) — the same
//   rules as creating one account by hand (auth.schemas.ts), plus: nothing twice in the file,
//   nothing already taken, links only to people already at the school. A class that does not
//   exist yet is created.
// How: every row is checked and reported. Only when every row is fine, and it is not a dry
//   run, is anything written — all of it in one transaction, so an import never half-lands.
import { Errors } from '../../shared/errors/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import { EmailSchema, FullNameSchema, StudentIdSchema } from '../auth/auth.schemas.js';
import { hashSecret } from '../auth/password.js';
import type { ImportsRepository, NewAccount } from './imports.repository.js';
import type { ImportPeopleBody, ImportReportDto, ParentRow, StudentRow, TeacherRow } from './imports.schemas.js';

const MAX_CLASS_NAME = 100;
/** argon2 runs on libuv's pool (4 threads by default): hash a few at a time, not 500 at once. */
const HASH_CONCURRENCY = 4;

interface CheckedRow {
  fullName: string;
  identifier: string;
  problems: string[];
  account: Omit<NewAccount, 'secretHash'> & { secret: string };
}

const clean = (value: string | undefined) => (value ?? '').trim();
const isValid = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: string) => schema.safeParse(value).success;

async function mapLimited<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Collects the class names rows ask for: existing ones by key, new ones in first-seen spelling. */
function classPlanner(existing: { name: string }[]) {
  const known = new Set(existing.map((c) => c.name.toLowerCase()));
  const created = new Map<string, string>();
  return {
    /** The key to store, or a problem. */
    use(name: string, problems: string[]): string | null {
      if (!name) return null;
      if (name.length > MAX_CLASS_NAME) {
        problems.push(`Class "${name.slice(0, 20)}…" is longer than ${MAX_CLASS_NAME} characters`);
        return null;
      }
      const key = name.toLowerCase();
      if (!known.has(key) && !created.has(key)) created.set(key, name);
      return key;
    },
    newClasses: () => [...created.values()],
  };
}

function checkName(row: { fullName?: string | undefined }, problems: string[]): string {
  const fullName = clean(row.fullName);
  if (!fullName) problems.push('Full name is missing');
  else if (!isValid(FullNameSchema, fullName)) problems.push('Full name must be 1–100 characters');
  return fullName;
}

/** Email and password, the same rules as an account made by hand; each email once in the file. */
function checkAdult(row: TeacherRow | ParentRow, seenEmails: Set<string>, problems: string[]): { email: string; password: string } {
  const email = clean(row.email).toLowerCase();
  if (!email) problems.push('Email address is missing');
  else if (!isValid(EmailSchema, email)) problems.push('Email address is not valid');
  else if (seenEmails.has(email)) problems.push('This email address is in the file twice');
  seenEmails.add(email);
  const password = row.password ?? '';
  if (!password) problems.push('Password is missing');
  else if (password.length < 10 || password.length > 128) problems.push('Password must be 10–128 characters');
  return { email, password };
}

export function createImportsService(deps: { repository: ImportsRepository }) {
  const { repository } = deps;

  async function schoolFor(actor: Actor, schoolId: string | undefined): Promise<string> {
    if (actor.role === Role.SchoolAdmin) {
      if (actor.schoolId === null) throw Errors.forbidden();
      if (schoolId !== undefined && schoolId !== actor.schoolId) {
        throw Errors.forbidden('School Admins can only import into their own school.');
      }
      return actor.schoolId;
    }
    if (actor.role !== Role.PlatformAdmin) throw Errors.forbidden();
    if (schoolId === undefined) throw Errors.validation([{ field: 'schoolId', message: 'is required' }]);
    if (!(await repository.schoolExists(schoolId))) throw Errors.invalidReference('schoolId', 'School not found.');
    return schoolId;
  }

  async function checkStudents(schoolId: string, rows: StudentRow[], planner: ReturnType<typeof classPlanner>): Promise<CheckedRow[]> {
    const seenIds = new Set<string>();
    const checked = rows.map((row) => {
      const problems: string[] = [];
      const fullName = checkName(row, problems);
      const studentId = clean(row.studentId).toUpperCase();
      if (!studentId) problems.push('Student ID is missing');
      else if (!isValid(StudentIdSchema, studentId)) problems.push('Student ID must be 3–32 letters, digits or hyphens');
      else if (seenIds.has(studentId)) problems.push('This student ID is in the file twice');
      seenIds.add(studentId);
      const pin = clean(row.pin);
      if (!pin) problems.push('PIN is missing');
      else if (!/^[0-9]{6}$/.test(pin)) problems.push('PIN must be exactly 6 digits');
      const parentEmail = clean(row.parentEmail).toLowerCase();
      if (parentEmail && !isValid(EmailSchema, parentEmail)) problems.push('Parent email is not valid');
      const classKey = planner.use(clean(row.className), problems);
      return { fullName, studentId, pin, parentEmail, classKey, problems };
    });

    const taken = await repository.takenStudentIds(checked.map((r) => r.studentId).filter(Boolean));
    const parents = await repository.parentsByEmail(schoolId, [...new Set(checked.map((r) => r.parentEmail).filter(Boolean))]);
    return checked.map((r) => {
      if (taken.has(r.studentId)) r.problems.push('This student ID is already in use');
      const parentId = r.parentEmail ? (parents.get(r.parentEmail) ?? null) : null;
      if (r.parentEmail && !parentId) r.problems.push(`No parent with the email ${r.parentEmail} at this school: import parents first, or leave it empty`);
      return {
        fullName: r.fullName,
        identifier: r.studentId,
        problems: r.problems,
        account: {
          role: 'student',
          fullName: r.fullName,
          email: null,
          studentLoginId: r.studentId,
          secret: r.pin,
          classKeys: r.classKey ? [r.classKey] : [],
          parentId,
          childIds: [],
        },
      };
    });
  }

  async function checkTeachers(rows: TeacherRow[], planner: ReturnType<typeof classPlanner>): Promise<CheckedRow[]> {
    const seenEmails = new Set<string>();
    const checked = rows.map((row) => {
      const problems: string[] = [];
      const fullName = checkName(row, problems);
      const { email, password } = checkAdult(row, seenEmails, problems);
      const classKeys = [...new Set((row.classNames ?? []).map((name) => planner.use(name.trim(), problems)).filter((k): k is string => k !== null))];
      return { fullName, email, password, classKeys, problems };
    });
    const taken = await repository.takenEmails(checked.map((r) => r.email).filter(Boolean));
    return checked.map((r) => {
      if (taken.has(r.email)) r.problems.push('This email address is already in use');
      return {
        fullName: r.fullName,
        identifier: r.email,
        problems: r.problems,
        account: { role: 'teacher', fullName: r.fullName, email: r.email, studentLoginId: null, secret: r.password, classKeys: r.classKeys, parentId: null, childIds: [] },
      };
    });
  }

  async function checkParents(schoolId: string, rows: ParentRow[]): Promise<CheckedRow[]> {
    const seenEmails = new Set<string>();
    const claimed = new Set<string>();
    const checked = rows.map((row) => {
      const problems: string[] = [];
      const fullName = checkName(row, problems);
      const { email, password } = checkAdult(row, seenEmails, problems);
      const childLoginIds = [...new Set((row.childStudentIds ?? []).map((id) => id.trim().toUpperCase()).filter(Boolean))];
      return { fullName, email, password, childLoginIds, problems };
    });
    const taken = await repository.takenEmails(checked.map((r) => r.email).filter(Boolean));
    const students = await repository.studentsByLoginId(schoolId, [...new Set(checked.flatMap((r) => r.childLoginIds))]);
    return checked.map((r) => {
      if (taken.has(r.email)) r.problems.push('This email address is already in use');
      const childIds: string[] = [];
      for (const loginId of r.childLoginIds) {
        const student = students.get(loginId);
        if (!student) r.problems.push(`No student with the ID ${loginId} at this school`);
        else if (student.hasParent) r.problems.push(`${loginId} already has a parent linked`);
        else if (claimed.has(loginId)) r.problems.push(`${loginId} is claimed by two parents in the file`);
        else childIds.push(student.id);
        claimed.add(loginId);
      }
      return {
        fullName: r.fullName,
        identifier: r.email,
        problems: r.problems,
        account: { role: 'parent', fullName: r.fullName, email: r.email, studentLoginId: null, secret: r.password, classKeys: [], parentId: null, childIds },
      };
    });
  }

  async function importPeople(actor: Actor, body: ImportPeopleBody): Promise<ImportReportDto> {
    const schoolId = await schoolFor(actor, body.schoolId);
    const planner = classPlanner(await repository.classesOf(schoolId));
    const rows =
      body.role === 'student'
        ? await checkStudents(schoolId, body.rows, planner)
        : body.role === 'teacher'
          ? await checkTeachers(body.rows, planner)
          : await checkParents(schoolId, body.rows);
    const isEveryRowFine = rows.every((row) => row.problems.length === 0);
    const newClasses = body.role === 'parent' ? [] : planner.newClasses();

    let created = 0;
    if (isEveryRowFine && !body.dryRun) {
      const accounts = await mapLimited(rows, HASH_CONCURRENCY, async ({ account: { secret, ...account } }) => ({
        ...account,
        secretHash: await hashSecret(secret),
      }));
      await repository.create(schoolId, newClasses, accounts);
      created = accounts.length;
    }

    return {
      role: body.role,
      dryRun: body.dryRun,
      isValid: isEveryRowFine,
      created,
      newClasses,
      rows: rows.map((row, index) => ({ row: index + 1, fullName: row.fullName, identifier: row.identifier, problems: row.problems })),
    };
  }

  return { importPeople };
}

export type ImportsService = ReturnType<typeof createImportsService>;
