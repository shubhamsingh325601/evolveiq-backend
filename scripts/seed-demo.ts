// Fills a DEVELOPMENT database with a believable demo: two schools, every role, classes,
// activities of all five types, observations at every stage of review, assignments and a few
// completed ones (spread over the last days so streaks show). The same people and stories as
// the frontend's offline mock, so the frontend's demo accounts work against the real API too.
//
// Everything except the first Platform Admin goes through the real API in-process
// (app.inject), so every validation and business rule applies. Refuses to run in production.
// If the demo school already exists, the people and stories are left alone and only what came
// later is added where it is still missing (client feedback, 29 Oct 2026: health and care
// needs, a month of attendance, notices, staff reviews and the celebration wall), so a demo
// database seeded before then can be brought up to date by running it again.
//
//   npm run db:seed-demo
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashSecret } from '../src/modules/auth/password.js';
import { businessDate, businessMonth } from '../src/modules/progress/business-time.js';
import { createPrismaClient } from '../src/shared/db/prisma.js';

/** Every demo adult signs in with this password; every demo student with DEMO_PIN. */
const DEMO_PASSWORD = 'EvolvIQ-Demo-2026';
const DEMO_PIN = '246810';
const PLATFORM_ADMIN = { fullName: 'Tunde Oyelaran', email: 'tunde@evolveiq.test' };
const DEMO_SCHOOL = 'Ridgeview Primary';

if (process.env.NODE_ENV === 'production') {
  console.error('seed-demo is for development databases only.');
  process.exit(1);
}

const config = loadConfig();
const db = createPrismaClient({ databaseUrl: config.databaseUrl, poolMax: 2 });
const app = await buildApp({ config, db });

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function call<T>(method: Method, url: string, token?: string, body?: unknown): Promise<T> {
  const response = await app.inject({
    method,
    url: `/api/v1${url}`,
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (response.statusCode >= 400) {
    throw new Error(`${method} ${url} → ${response.statusCode} ${response.body}`);
  }
  return (response.statusCode === 204 ? undefined : response.json()) as T;
}

async function login(credentials: { email: string } | { studentId: string }): Promise<string> {
  const body = 'email' in credentials ? { ...credentials, password: DEMO_PASSWORD } : { ...credentials, pin: DEMO_PIN };
  return (await call<{ accessToken: string }>('POST', '/auth/login', undefined, body)).accessToken;
}

async function register(token: string, body: Record<string, unknown>): Promise<string> {
  const secret = body.role === 'student' ? { pin: DEMO_PIN } : { password: DEMO_PASSWORD };
  return (await call<{ user: { id: string } }>('POST', '/auth/register', token, { ...body, ...secret })).user.id;
}

try {
  const existing = await db.school.findFirst({ where: { name: DEMO_SCHOOL }, select: { id: true } });
  if (existing) {
    console.log(`"${DEMO_SCHOOL}" already exists, so its people and stories are in. Adding only what is missing.`);
  } else {
    await seed();
  }
  await seedLaterAdditions();
} finally {
  await app.close();
  await db.$disconnect();
}

async function seed(): Promise<void> {
  // ---------- The first Platform Admin (registration is admin-only, so it goes in directly) ----------
  await db.$executeRaw`
    INSERT INTO users (role, full_name, email, secret_hash)
    VALUES ('platform_admin', ${PLATFORM_ADMIN.fullName}, ${PLATFORM_ADMIN.email}, ${await hashSecret(DEMO_PASSWORD)})
    ON CONFLICT (email) WHERE email IS NOT NULL DO NOTHING`;
  const platform = await login({ email: PLATFORM_ADMIN.email });

  // ---------- Schools and their admins ----------
  const school = async (name: string) => (await call<{ school: { id: string } }>('POST', '/schools', platform, { name })).school.id;
  const ridgeview = await school(DEMO_SCHOOL);
  const halden = await school('Halden Grove School');

  await register(platform, { role: 'school_admin', fullName: 'Clara Fernandes', email: 'clara@school.test', schoolId: ridgeview });
  await register(platform, { role: 'school_admin', fullName: 'Farah Khan', email: 'farah@halden.test', schoolId: halden });
  await register(platform, { role: 'psychologist', fullName: 'Dr. Anand Mehta', email: 'mehta@school.test' });
  const clara = await login({ email: 'clara@school.test' });
  const farah = await login({ email: 'farah@halden.test' });

  // ---------- Ridgeview people (created by its School Admin, so the school comes from her token) ----------
  const rao = await register(clara, { role: 'teacher', fullName: 'Sunita Rao', email: 'rao@school.test' });
  const kapoor = await register(clara, { role: 'teacher', fullName: 'Ritu Kapoor', email: 'ritu@school.test' });
  const priya = await register(clara, { role: 'parent', fullName: 'Priya Ahluwalia', email: 'priya@family.test' });
  const neil = await register(clara, { role: 'parent', fullName: 'Neil D’Souza', email: 'neil@family.test' });

  const student = (fullName: string, studentId: string, parentId?: string) =>
    register(clara, { role: 'student', fullName, studentId, ...(parentId ? { parentId } : {}) });
  const maya = await student('Maya Ahluwalia', 'RV-1001', priya);
  const arjun = await student('Arjun Ahluwalia', 'RV-1002', priya);
  const devan = await student('Devan D’Souza', 'RV-1003', neil);
  const lila = await student('Lila Menon', 'RV-1004');
  const noor = await student('Noor Siddiqui', 'RV-1005');
  const ibrahim = await student('Ibrahim Qureshi', 'RV-1006');
  const tara = await student('Tara Bhatt', 'RV-1007');

  const classOf = async (token: string, name: string, teachers: string[], students: string[]) => {
    const id = (await call<{ class: { id: string } }>('POST', '/classes', token, { name })).class.id;
    for (const teacher of teachers) await call('PUT', `/classes/${id}/teachers/${teacher}`, token);
    for (const pupil of students) await call('PUT', `/classes/${id}/students/${pupil}`, token);
  };
  await classOf(clara, '4B', [rao], [maya, arjun, devan]);
  await classOf(clara, '3A', [rao], [lila, noor]);
  await classOf(clara, '5C', [kapoor], [ibrahim, tara]);

  // ---------- Halden Grove: a smaller school, so the platform view has more than one ----------
  const omar = await register(farah, { role: 'teacher', fullName: 'Omar Haddad', email: 'omar@halden.test' });
  const zoe = await register(farah, { role: 'student', fullName: 'Zoe Pinto', studentId: 'HG-2001' });
  const kabir = await register(farah, { role: 'student', fullName: 'Kabir Shah', studentId: 'HG-2002' });
  await classOf(farah, '6A', [omar], [zoe, kabir]);

  // ---------- The activity library (written by the psychologist) ----------
  const mehta = await login({ email: 'mehta@school.test' });
  const activity = async (title: string, content: Record<string, unknown>) =>
    (await call<{ activity: { id: string } }>('POST', '/activities', mehta, { title, content })).activity.id;
  const face = (text: string, colour: string) => `https://placehold.co/320x240/${colour}/ffffff/png?text=${text}`;

  const sorting = await activity('Sort the morning', {
    type: 'mcq',
    prompt: 'Which one comes first in the morning?',
    options: [
      { id: 'shoes', label: 'Put on shoes' },
      { id: 'wake', label: 'Wake up' },
      { id: 'breakfast', label: 'Eat breakfast' },
      { id: 'bag', label: 'Pack the bag' },
    ],
  });
  const feelings = await activity('How are you feeling today?', {
    type: 'image_pick',
    prompt: 'Pick the picture that matches how you feel right now.',
    options: [
      { id: 'happy', label: 'Happy', imageUrl: face('Happy', 'f59e0b') },
      { id: 'calm', label: 'Calm', imageUrl: face('Calm', '10b981') },
      { id: 'worried', label: 'Worried', imageUrl: face('Worried', '6366f1') },
      { id: 'cross', label: 'Cross', imageUrl: face('Cross', 'ef4444') },
    ],
  });
  const story = await activity('Tell me about your day', { type: 'text', prompt: 'What was the best part of your day, and why?' });
  const homework = await activity('How tricky was homework?', {
    type: 'rating',
    prompt: 'How tricky did today’s homework feel? 1 is very easy, 5 is very hard.',
  });
  const video = await activity('Watch and tell', {
    type: 'media_response',
    prompt: 'Watch the flower open. What did you notice changing?',
    mediaUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  });

  // ---------- Observations: concerns for review, and positive ones that are stars ----------
  const raoToken = await login({ email: 'rao@school.test' });
  const kapoorToken = await login({ email: 'ritu@school.test' });
  const priyaToken = await login({ email: 'priya@family.test' });
  const neilToken = await login({ email: 'neil@family.test' });

  const observe = async (token: string, path: '/observations' | '/family/observations', body: Record<string, unknown>) =>
    (await call<{ observation: { id: string } }>('POST', path, token, body)).observation.id;
  const byTeacher = (token: string, body: Record<string, unknown>) => observe(token, '/observations', body);
  const byParent = (token: string, body: Record<string, unknown>) => observe(token, '/family/observations', body);

  // Concerns: what goes to the psychologist's queue.
  const readingBlock = await byTeacher(raoToken, {
    studentId: maya, area: 'learning', when: 'this_week', howOften: 'often', level: 'minor', learningBehaviourArea: 'attention',
    description: 'Maya drifts off during the afternoon reading block and needs two or three reminders to get back to her page.',
  });
  await byTeacher(raoToken, {
    studentId: devan, area: 'emotions', when: 'today', howOften: 'sometimes', level: 'significant', learningBehaviourArea: 'self_control',
    description: 'Devan left the room without asking when the fire drill alarm sounded, and needed about fifteen minutes before he could come back in.',
  });
  await byTeacher(raoToken, {
    studentId: noor, area: 'physical', when: 'this_week', howOften: 'daily', level: 'significant', learningBehaviourArea: 'task_completion',
    description: 'Noor is still holding the pencil in a full fist grip. She tires after roughly five minutes of writing and asks to stop.',
  });
  const worksheet = await byTeacher(raoToken, {
    studentId: lila, area: 'learning', when: 'this_month', howOften: 'often', level: 'moderate', learningBehaviourArea: 'task_completion',
    description: 'Lila stops at the first tricky question on a maths worksheet and waits for help instead of trying the next one.',
  });
  const lunchQueue = await byTeacher(kapoorToken, {
    studentId: tara, area: 'behaviour', when: 'this_week', howOften: 'sometimes', level: 'minor', learningBehaviourArea: 'self_control',
    description: 'Tara pushed ahead in the lunch queue twice this week and was upset when she was asked to go back.',
  });
  await byTeacher(kapoorToken, {
    studentId: ibrahim, area: 'learning', when: 'today', howOften: 'often', level: 'significant', learningBehaviourArea: 'following_instructions',
    description: 'Ibrahim could not recall the three-step instruction even straight after I gave it. This happened in both sessions today.',
  });

  const assembly = await byParent(priyaToken, {
    studentId: maya, area: 'emotions', when: 'this_month', howOften: 'once',
    description: 'Maya was so nervous before the school assembly that she asked to stay at home. Once she was there, she said she enjoyed it.',
  });
  await byParent(priyaToken, {
    studentId: maya, area: 'social', when: 'this_week', howOften: 'often',
    description: 'At her cousin’s birthday she waited for her turn at the game twice, then got upset the third time and walked away.',
  });

  // Positive: each one is a star on the student's profile straight away, and is never reviewed.
  const star = { tone: 'positive' } as const;
  await byTeacher(raoToken, {
    ...star, studentId: maya, area: 'learning', when: 'this_week', howOften: 'once', learningBehaviourArea: 'attention',
    description: 'Maya stayed with the tangram puzzle for almost ten minutes without being prompted, which is the longest she has worked on one thing this term.',
  });
  await byTeacher(raoToken, {
    ...star, studentId: arjun, area: 'communication', when: 'today', howOften: 'once', learningBehaviourArea: 'participation',
    description: 'Arjun told the class about the museum trip with a clear beginning, middle and end, and answered three questions without his notes.',
  });
  await byTeacher(raoToken, {
    ...star, studentId: lila, area: 'learning', when: 'this_month', howOften: 'once',
    description: 'When the block tower fell, Lila rebuilt it with a wider base without anyone suggesting it.',
  });
  await byTeacher(raoToken, {
    ...star, studentId: noor, area: 'social', when: 'today', howOften: 'once', learningBehaviourArea: 'working_with_others',
    description: 'Noor noticed a classmate sitting alone at lunch, invited her to join the table and introduced her to everyone.',
  });
  await byTeacher(kapoorToken, {
    ...star, studentId: tara, area: 'routines', when: 'this_week', howOften: 'daily', learningBehaviourArea: 'organisation',
    description: 'Tara packed her own bag and checked the timetable herself for three days running, with no reminder from me.',
  });
  await byTeacher(kapoorToken, {
    ...star, studentId: ibrahim, area: 'behaviour', when: 'this_week', howOften: 'once', learningBehaviourArea: 'working_with_others',
    description: 'Ibrahim tidied the art corner without being asked and showed a younger pupil where the brushes go.',
  });
  await byParent(priyaToken, {
    ...star, studentId: arjun, area: 'communication', when: 'today', howOften: 'once',
    description: 'Arjun told the whole story of his school trip at dinner without losing track, and used words I have not heard him use before.',
  });
  await byParent(priyaToken, {
    ...star, studentId: maya, area: 'routines', when: 'this_week', howOften: 'sometimes',
    description: 'Maya laid out her uniform and packed her school bag the night before, all on her own.',
  });
  await byParent(neilToken, {
    ...star, studentId: devan, area: 'emotions', when: 'this_week', howOften: 'sometimes',
    description: 'He managed the change of plan on Saturday much better than he would have a month ago. He asked what was happening instead of shutting down.',
  });

  // ---------- Reviews: "Assign & mark reviewed" creates the recommended assignments ----------
  const review = (observationId: string, body: Record<string, unknown>) =>
    call('POST', `/observations/${observationId}/review`, mehta, body);
  await review(readingBlock, {
    outcome: 'assigned', developmentArea: 'focus_attention', activityIds: [sorting],
    teacherOnlyNote: 'Try the same short task at the same time each day, and see whether the reminders drop.',
  });
  await review(assembly, { outcome: 'assigned', developmentArea: 'confidence', activityIds: [feelings] });
  await review(worksheet, { outcome: 'assigned', developmentArea: 'learning_skills', activityIds: [homework] });
  await review(lunchQueue, {
    outcome: 'no_action', teacherOnlyNote: 'Worth watching, but nothing to act on yet. Tell me if it happens again.',
  });

  // ---------- Direct assignments from teachers ----------
  const assign = async (token: string, studentId: string, activityId: string) =>
    (await call<{ assignment: { id: string } }>('POST', '/assignments', token, { studentId, activityId })).assignment.id;
  const mayaStory = await assign(raoToken, maya, story);
  await assign(raoToken, maya, homework);
  const arjunStory = await assign(raoToken, arjun, story);
  await assign(raoToken, devan, video);
  await assign(raoToken, noor, feelings);
  const taraStory = await assign(kapoorToken, tara, story);

  // ---------- Completions, moved back in time so the streaks have something to show ----------
  const complete = async (studentLoginId: string, assignmentId: string, answer: Record<string, unknown>, daysAgo: number) => {
    const token = await login({ studentId: studentLoginId });
    const { completion } = await call<{ completion: { id: string } }>('POST', '/activity-completions', token, { assignmentId, answer });
    if (daysAgo > 0) {
      await db.$executeRaw`UPDATE activity_completions SET completed_at = now() - make_interval(days => ${daysAgo}) WHERE id = ${completion.id}::uuid`;
    }
  };
  const assignmentFor = async (studentId: string, activityId: string) =>
    (await db.assignment.findFirstOrThrow({ where: { studentId, activityId }, select: { id: true } })).id;

  await complete('RV-1001', await assignmentFor(maya, feelings), { type: 'image_pick', optionId: 'happy' }, 2);
  await complete('RV-1001', mayaStory, { type: 'text', text: 'We built a volcano in science and it really fizzed!' }, 1);
  await complete('RV-1002', arjunStory, { type: 'text', text: 'Telling everyone about the museum trip.' }, 0);
  await complete('RV-1007', taraStory, { type: 'text', text: 'Art, because I finished my painting.' }, 3);

  console.log('Demo data is in. Sign in with any of these:');
  console.table([
    { role: 'Platform Admin', signIn: PLATFORM_ADMIN.email },
    { role: 'School Admin', signIn: 'clara@school.test' },
    { role: 'Counsellor (psychologist)', signIn: 'mehta@school.test' },
    { role: 'Teacher', signIn: 'rao@school.test' },
    { role: 'Teacher', signIn: 'ritu@school.test' },
    { role: 'Parent', signIn: 'priya@family.test' },
    { role: 'Parent', signIn: 'neil@family.test' },
    { role: 'Student', signIn: 'RV-1001 (Maya)' },
    { role: 'Student', signIn: 'RV-1002 (Arjun)' },
  ]);
  console.log(`Adults use the password ${DEMO_PASSWORD}; students use the PIN ${DEMO_PIN}.`);
}

// ───────────────────────────── Added later (client feedback, 29 Oct 2026) ─────────────────────────────
// Each part runs only when its table holds nothing for the demo school yet, so running the seed
// again never doubles anything. (Function declarations, not consts: the code at the top of the
// file runs before anything declared down here with const is initialised.)

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/** A stable number in [0, 1) for a piece of text, so the demo register is the same every time. */
function unit(text: string): number {
  let hash = 2166136261; // FNV-1a, then a finaliser so near-identical texts land far apart
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32;
}

async function seedLaterAdditions(): Promise<void> {
  const ridgeview = await db.school.findFirst({ where: { name: DEMO_SCHOOL }, select: { id: true } });
  const halden = await db.school.findFirst({ where: { name: 'Halden Grove School' }, select: { id: true } });
  if (!ridgeview) return;

  const idOf = async (where: { email: string } | { studentLoginId: string }) =>
    (await db.user.findFirstOrThrow({ where, select: { id: true } })).id;
  const today = businessDate(new Date());
  const thisMonth = businessMonth(new Date());
  const lastMonth = previousMonth(thisMonth);

  const clara = await login({ email: 'clara@school.test' });
  const platform = await login({ email: PLATFORM_ADMIN.email });
  const added: string[] = [];

  // ---------- Health and care needs: what each family (or the school office) told the school ----------
  const ridgeviewStudents = { student: { schoolId: ridgeview.id } };
  if ((await db.healthProfile.count({ where: ridgeviewStudents })) === 0) {
    const priya = await login({ email: 'priya@family.test' });
    const neil = await login({ email: 'neil@family.test' });
    const record = (token: string, studentId: string, body: Record<string, unknown>) => call('PUT', `/students/${studentId}/health`, token, body);
    await record(priya, await idOf({ studentLoginId: 'RV-1001' }), {
      conditions: ['asthma', 'on_medication'],
      bloodGroup: 'B+',
      allergies: 'Dust and pollen',
      medications: 'Blue reliever inhaler before PE and when wheezy. It is in the front pocket of her bag.',
      careNotes: 'If she is wheezy, let her use her inhaler and sit out. Please call me if it has not settled within ten minutes.',
      emergencyContact: { name: 'Priya Ahluwalia', relation: 'Mother', phone: '+91 98765 43210' },
    });
    await record(priya, await idOf({ studentLoginId: 'RV-1002' }), {
      conditions: ['severe_allergy'],
      bloodGroup: 'B+',
      allergies: 'Peanuts and tree nuts (anaphylaxis)',
      medications: 'Adrenaline auto-injector, kept in the school office.',
      careNotes: 'No food sharing. If he has swelling or trouble breathing, use the auto-injector and call an ambulance (108), then me.',
      emergencyContact: { name: 'Priya Ahluwalia', relation: 'Mother', phone: '+91 98765 43210' },
    });
    await record(neil, await idOf({ studentLoginId: 'RV-1003' }), {
      conditions: ['adhd'],
      careNotes: 'Short tasks with a movement break between them work best. A two-minute warning before a change of activity helps him a lot.',
      emergencyContact: { name: 'Neil D’Souza', relation: 'Father', phone: '+91 98765 43211' },
    });
    await record(clara, await idOf({ studentLoginId: 'RV-1005' }), {
      conditions: ['visual_impairment'],
      careNotes: 'Wears glasses for distance. Seat her near the board and print worksheets in a larger font.',
    });
    await record(clara, await idOf({ studentLoginId: 'RV-1006' }), {
      conditions: ['dyslexia'],
      careNotes: 'Give instructions one step at a time, and read written instructions aloud. Extra time in written tests.',
    });
    await record(clara, await idOf({ studentLoginId: 'RV-1007' }), {
      conditions: ['diabetes', 'on_medication'],
      bloodGroup: 'A+',
      medications: 'Insulin before lunch, given by the school nurse.',
      careNotes: 'Checks her blood sugar before lunch and PE. Glucose tablets are in the class first-aid box: give two if she feels shaky or dizzy.',
    });
    added.push('health and care needs for six Ridgeview students');
  }

  // ---------- Attendance: the last 30 days, Monday to Saturday, taken by each class's teacher ----------
  if ((await db.attendanceRecord.count({ where: ridgeviewStudents })) === 0) {
    const teacherTokens = new Map<string, string>();
    const tokenFor = async (email: string) => {
      if (!teacherTokens.has(email)) teacherTokens.set(email, await login({ email }));
      return teacherTokens.get(email)!;
    };
    // How often each child is in, so the register reads like a real one (Devan's is the one to watch).
    const usualRate: Record<string, number> = {
      'RV-1001': 0.88, 'RV-1002': 0.96, 'RV-1003': 0.72, 'RV-1004': 0.92, 'RV-1005': 0.9, 'RV-1006': 0.84, 'RV-1007': 0.94,
      'HG-2001': 0.9, 'HG-2002': 0.86,
    };
    const registers = [
      { schoolId: ridgeview.id, name: '4B', teacher: 'rao@school.test' },
      { schoolId: ridgeview.id, name: '3A', teacher: 'rao@school.test' },
      { schoolId: ridgeview.id, name: '5C', teacher: 'ritu@school.test' },
      ...(halden ? [{ schoolId: halden.id, name: '6A', teacher: 'omar@halden.test' }] : []),
    ];
    for (const register of registers) {
      const group = await db.class.findFirst({
        where: { schoolId: register.schoolId, name: register.name },
        select: { id: true, students: { select: { student: { select: { id: true, studentLoginId: true } } } } },
      });
      if (!group || group.students.length === 0) continue;
      const token = await tokenFor(register.teacher);
      for (let back = 29; back >= 0; back -= 1) {
        const day = addDays(today, -back);
        if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) continue; // Sunday
        const records = group.students.map(({ student }) => {
          const roll = unit(`${student.studentLoginId}:${day}`);
          const rate = usualRate[student.studentLoginId ?? ''] ?? 0.9;
          return { studentId: student.id, status: roll >= rate ? 'absent' : roll < 0.06 ? 'late' : 'present' };
        });
        await call('PUT', `/classes/${group.id}/attendance/${day}`, token, { records });
      }
    }
    added.push('a month of attendance for every class');
  }

  // ---------- The notice board ----------
  const anyNotice = await db.notice.count({ where: { OR: [{ schoolId: ridgeview.id }, { schoolId: null }] } });
  if (anyNotice === 0) {
    const post = (token: string, body: Record<string, unknown>) => call('POST', '/notices', token, body);
    await post(clara, {
      category: 'event', title: 'Annual Sports Day', startsOn: addDays(today, 10), location: 'Main ground', isPinned: true,
      body: 'Races, relays and a tug of war for every class. Families are welcome from 9:00. Please send your child in their house colours with a water bottle.',
    });
    await post(clara, {
      category: 'activity', title: 'Inter-house science fair', startsOn: addDays(today, 20), location: 'Hall B',
      body: 'Projects in pairs, on anything that makes you curious. Sign up with your class teacher by Friday.',
    });
    await post(clara, {
      category: 'event', title: 'Parent–teacher meeting', startsOn: addDays(today, 14), location: 'Classrooms', audience: 'families',
      body: 'Fifteen-minute conversations with your child’s class teacher. Book a slot through the school office.',
    });
    await post(clara, {
      category: 'training', title: 'First aid and CPR training', startsOn: addDays(today, 6), location: 'Staff room', audience: 'staff',
      body: 'A three-hour session with a certified trainer, for every class teacher. Bring the class first-aid box so we can restock it.',
    });
    await post(platform, {
      category: 'policy', title: 'Fire-safety drills: what changes this term',
      body: 'Every school runs two fire drills a term, marks its assembly points, and names a fire warden for each class. Your school will share its dates on this board.',
    });
    await post(platform, {
      category: 'policy', title: 'Safeguarding refresher for every staff member', audience: 'staff',
      body: 'Please complete the yearly safeguarding refresher this term. It covers spotting concerns, recording them and who to tell.',
    });
    for (const [title, phone, body] of [
      ['National emergency number', '112', 'Police, fire and ambulance, from any phone.'],
      ['Ambulance', '108', 'Free emergency ambulance.'],
      ['Childline', '1098', 'Free, 24-hour help for children and for adults worried about a child.'],
    ] as const) {
      await post(platform, { category: 'emergency_contact', title, phone, body });
    }
    added.push('notices: events, an activity, a training, policy updates and emergency numbers');
  }

  // ---------- Staff reviews and the celebration wall ----------
  const rao = await idOf({ email: 'rao@school.test' });
  const kapoor = await idOf({ email: 'ritu@school.test' });
  if ((await db.staffReview.count({ where: { schoolId: ridgeview.id } })) === 0) {
    const review = (staffId: string, month: string, body: Record<string, unknown>) => call('PUT', `/staff-reviews/${staffId}/${month}`, clara, body);
    await review(rao, lastMonth, {
      teaching: 5, engagement: 5, punctuality: 4, teamwork: 5, communication: 5,
      comment: 'Started the reading-buddies scheme and kept every family in the loop.',
    });
    await review(kapoor, lastMonth, {
      teaching: 4, engagement: 4, punctuality: 5, teamwork: 4, communication: 3,
      comment: 'Well-run lessons. Let us find a way to share more with parents each week.',
    });
    await review(rao, thisMonth, { teaching: 5, engagement: 4, punctuality: 5, teamwork: 5, communication: 4 });
    await review(kapoor, thisMonth, {
      teaching: 4, engagement: 5, punctuality: 5, teamwork: 4, communication: 4,
      comment: 'The new art corner has every child in 5C talking about their work.',
    });
    added.push('staff reviews for this month and last');
  }
  if ((await db.honour.count({ where: { schoolId: ridgeview.id } })) === 0) {
    const honour = (body: Record<string, unknown>) => call('POST', '/honours', clara, body);
    await honour({
      kind: 'staff_of_month', month: lastMonth, honoreeId: rao,
      citation: 'For the reading-buddies scheme: every Year 3 reader now has a Year 4 buddy, and every family heard how it went.',
    });
    await honour({
      kind: 'student_of_month', month: lastMonth, honoreeId: await idOf({ studentLoginId: 'RV-1005' }),
      citation: 'For kindness: Noor noticed a classmate sitting alone at lunch and made her feel at home.',
    });
    await honour({
      kind: 'staff_of_month', month: thisMonth, honoreeId: kapoor,
      citation: 'For the new art corner, where every pupil in 5C now has a piece on the wall.',
    });
    await honour({
      kind: 'student_of_month', month: thisMonth, honoreeId: await idOf({ studentLoginId: 'RV-1002' }),
      citation: 'For telling the class about the museum trip with a clear beginning, middle and end, and answering every question.',
    });
    added.push('Staff and Students of the Month for this month and last');
  }

  console.log(added.length > 0 ? `Added: ${added.join('; ')}.` : 'Everything added since 29 Oct 2026 is already in.');
}
