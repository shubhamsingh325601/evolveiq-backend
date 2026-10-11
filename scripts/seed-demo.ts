// Fills a DEVELOPMENT database with a believable demo: two schools, every role, classes,
// activities of all five types, observations at every stage of review, assignments and a few
// completed ones (spread over the last days so streaks show). The same people and stories as
// the frontend's offline mock, so the frontend's demo accounts work against the real API too.
//
// Everything except the first Platform Admin goes through the real API in-process
// (app.inject), so every validation and business rule applies. Refuses to run in production,
// and does nothing if the demo school already exists.
//
//   npm run db:seed-demo
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashSecret } from '../src/modules/auth/password.js';
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
    console.log(`"${DEMO_SCHOOL}" already exists, so the demo data is already in. Nothing to do.`);
  } else {
    await seed();
  }
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

  // ---------- Observations ----------
  const raoToken = await login({ email: 'rao@school.test' });
  const kapoorToken = await login({ email: 'ritu@school.test' });
  const priyaToken = await login({ email: 'priya@family.test' });
  const neilToken = await login({ email: 'neil@family.test' });

  const observe = async (token: string, path: '/observations' | '/family/observations', body: Record<string, unknown>) =>
    (await call<{ observation: { id: string } }>('POST', path, token, body)).observation.id;
  const byTeacher = (token: string, body: Record<string, unknown>) => observe(token, '/observations', body);
  const byParent = (token: string, body: Record<string, unknown>) => observe(token, '/family/observations', body);

  const tangram = await byTeacher(raoToken, {
    studentId: maya, area: 'learning', when: 'this_week', howOften: 'sometimes', level: 'minor', learningBehaviourArea: 'attention',
    description: 'Maya stayed with the tangram puzzle for almost ten minutes without being prompted, which is the longest she has worked on one thing this term.',
  });
  await byTeacher(raoToken, {
    studentId: devan, area: 'emotions', when: 'today', howOften: 'sometimes', level: 'significant', learningBehaviourArea: 'self_control',
    description: 'Devan left the room without asking when the fire drill alarm sounded, and needed about fifteen minutes before he could come back in.',
  });
  await byTeacher(raoToken, {
    studentId: noor, area: 'physical', when: 'this_week', howOften: 'daily', level: 'significant', learningBehaviourArea: 'task_completion',
    description: 'Noor is still holding the pencil in a full fist grip. She tires after roughly five minutes of writing and asks to stop.',
  });
  const blocks = await byTeacher(raoToken, {
    studentId: lila, area: 'learning', when: 'this_month', howOften: 'once', level: 'minor', learningBehaviourArea: 'attention',
    description: 'When the block tower fell, Lila rebuilt it with a wider base without anyone suggesting it.',
  });
  const timetable = await byTeacher(kapoorToken, {
    studentId: tara, area: 'routines', when: 'this_week', howOften: 'daily', level: 'minor', learningBehaviourArea: 'organisation',
    description: 'Tara packed her own bag and checked the timetable herself for three days running, with no reminder from me.',
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
  const dinner = await byParent(priyaToken, {
    studentId: arjun, area: 'communication', when: 'today', howOften: 'once',
    description: 'Arjun told the whole story of his school trip at dinner without losing track, and used words I have not heard him use before.',
  });
  await byParent(neilToken, {
    studentId: devan, area: 'emotions', when: 'this_week', howOften: 'sometimes',
    description: 'He managed the change of plan on Saturday much better than he would have a month ago. He asked what was happening instead of shutting down.',
  });

  // ---------- Reviews: "Assign & mark reviewed" creates the recommended assignments ----------
  const review = (observationId: string, body: Record<string, unknown>) =>
    call('POST', `/observations/${observationId}/review`, mehta, body);
  await review(tangram, {
    outcome: 'assigned', developmentArea: 'focus_attention', activityIds: [sorting],
    teacherOnlyNote: 'Worth repeating the same task next week to see whether the duration holds.',
  });
  await review(assembly, { outcome: 'assigned', developmentArea: 'confidence', activityIds: [feelings] });
  await review(dinner, { outcome: 'assigned', developmentArea: 'communication', activityIds: [story] });
  await review(blocks, { outcome: 'assigned', developmentArea: 'learning_skills', activityIds: [homework] });
  await review(timetable, {
    outcome: 'no_action', teacherOnlyNote: 'Lovely to see. Nothing to change; keep noticing it.',
  });

  // ---------- Direct assignments from teachers ----------
  const assign = async (token: string, studentId: string, activityId: string) =>
    (await call<{ assignment: { id: string } }>('POST', '/assignments', token, { studentId, activityId })).assignment.id;
  const mayaStory = await assign(raoToken, maya, story);
  await assign(raoToken, maya, homework);
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
  await complete('RV-1002', await assignmentFor(arjun, story), { type: 'text', text: 'Telling everyone about the museum trip.' }, 0);
  await complete('RV-1007', taraStory, { type: 'text', text: 'Art, because I finished my painting.' }, 3);

  console.log('Demo data is in. Sign in with any of these:');
  console.table([
    { role: 'Platform Admin', signIn: PLATFORM_ADMIN.email },
    { role: 'School Admin', signIn: 'clara@school.test' },
    { role: 'Psychologist', signIn: 'mehta@school.test' },
    { role: 'Teacher', signIn: 'rao@school.test' },
    { role: 'Teacher', signIn: 'ritu@school.test' },
    { role: 'Parent', signIn: 'priya@family.test' },
    { role: 'Parent', signIn: 'neil@family.test' },
    { role: 'Student', signIn: 'RV-1001 (Maya)' },
    { role: 'Student', signIn: 'RV-1002 (Arjun)' },
  ]);
  console.log(`Adults use the password ${DEMO_PASSWORD}; students use the PIN ${DEMO_PIN}.`);
}
