// The EvolvIQ Holistic Index (EHI): a 0–100 development index for one child, worked out from
// what teachers and parents have noticed and from the activities the child has finished.
// Pure functions only — no HTTP, no SQL, no clock (the caller passes `asOf`) — so every number
// can be reproduced and explained. There is no model behind it: a documented formula over
// counts, which is also what makes each insight explainable ("why", the factors, an action).
//
// Five pillars, each starting at a neutral 50 ("we have not seen enough yet") and moving with
// recent evidence:
//
//   Education  learning observations        + how many of the set activities were finished
//   Skills     communication, other         + activities finished in the last 90 days
//   Physical   physical, routines
//   Wellbeing  emotions, routines
//   Character  behaviour, social
//
// Every observation counts for the pillars its area feeds. A positive one (a star) adds 1, a
// concern subtracts a little less (Level: minor 0.5, moderate 1, significant 1.5, none 0.75),
// and a concern the counsellor has already reviewed counts half — it has been looked after.
// Evidence fades with a 75-day half-life, so the index follows the child, not their history.
// The net is squashed with tanh so a handful of notes moves the score and a hundred cannot
// break it; a pillar stays within 8–92 from observations alone.
//
// Parent-safe by construction: what leaves this module is scores, plain-language insights and
// counts of good things. Concern counts, Levels and review notes never appear in any text.
import type { ObservationArea, ObservationLevel, ObservationStatus, ObservationTone } from '../../generated/prisma/enums.js';
import { businessDate, businessMonth, monthBounds } from './business-time.js';

export const HOLISTIC_DIMENSIONS = ['education', 'skills', 'physical', 'wellbeing', 'character'] as const;
export type HolisticDimension = (typeof HOLISTIC_DIMENSIONS)[number];

export type Trend = 'up' | 'steady' | 'down';
export type Confidence = 'low' | 'medium' | 'high';

/** One observation, reduced to what the index needs. */
export interface Signal {
  tone: ObservationTone;
  area: ObservationArea;
  level: ObservationLevel | null;
  status: ObservationStatus;
  at: Date;
}

export interface HolisticInputs {
  signals: readonly Signal[];
  /** When each activity was assigned. */
  assigned: readonly Date[];
  /** When each activity was finished. */
  completions: readonly Date[];
}

export interface DimensionScore {
  dimension: HolisticDimension;
  score: number;
}

export interface HolisticYear {
  schoolYear: string;
  grade: string | null;
  score: number;
  isCurrent: boolean;
}

export interface HolisticMonth {
  /** "YYYY-MM", an Asia/Kolkata calendar month. */
  month: string;
  score: number;
}

export interface SkillScore {
  skill: string;
  score: number;
}

export interface HolisticInsight {
  dimension: HolisticDimension;
  trend: Trend;
  title: string;
  why: string;
  factors: string[];
  action: string;
  confidence: Confidence;
}

export interface HolisticIndex {
  score: number;
  dimensions: DimensionScore[];
  history: HolisticYear[];
  monthly: HolisticMonth[];
  skills: SkillScore[];
  strengths: string[];
  playbook: string[];
  insights: HolisticInsight[];
  evidence: { stars: number; activitiesCompleted: number };
}

// ───────────────────────────── The formula ─────────────────────────────

const DAY_MS = 86_400_000;
const NEUTRAL = 50;
const SWING = 42;
const SQUASH = 3;
const HALF_LIFE_DAYS = 75;
const CONCERN_WEIGHT: Record<ObservationLevel | 'none', number> = { minor: 0.5, moderate: 1, significant: 1.5, none: 0.75 };
const REVIEWED_FACTOR = 0.5;
const RECENT_DAYS = 90;
const TREND_DELTA = 3;
const MONTHS_SHOWN = 6;
const MAX_YEARS = 8;

const PILLAR_AREAS: Record<HolisticDimension, readonly ObservationArea[]> = {
  education: ['learning'],
  skills: ['communication', 'other'],
  physical: ['physical', 'routines'],
  wellbeing: ['emotions', 'routines'],
  character: ['behaviour', 'social'],
};

export const DIMENSION_LABELS: Record<HolisticDimension, string> = {
  education: 'Education',
  skills: 'Skills',
  physical: 'Physical',
  wellbeing: 'Wellbeing',
  character: 'Character',
};

/** What each observation area is called on the skill profile. */
const SKILL_NAMES: Record<ObservationArea, string> = {
  learning: 'Learning habits',
  communication: 'Communication',
  social: 'Teamwork',
  behaviour: 'Positive behaviour',
  emotions: 'Emotional awareness',
  physical: 'Active & healthy',
  routines: 'Daily routines',
  other: 'Curiosity',
};

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function weightOf(signal: Signal, asOf: Date): number {
  const ageDays = (asOf.getTime() - signal.at.getTime()) / DAY_MS;
  if (ageDays < 0) return 0; // not noticed yet, as of this date
  const decay = 0.5 ** (ageDays / HALF_LIFE_DAYS);
  if (signal.tone === 'positive') return decay;
  const base = CONCERN_WEIGHT[signal.level ?? 'none'];
  return -base * decay * (signal.status === 'reviewed' ? REVIEWED_FACTOR : 1);
}

function netFor(signals: readonly Signal[], areas: readonly ObservationArea[], asOf: Date): number {
  return signals.reduce((sum, s) => (areas.includes(s.area) ? sum + weightOf(s, asOf) : sum), 0);
}

const countIn = (dates: readonly Date[], from: Date, to: Date) =>
  dates.filter((d) => d.getTime() > from.getTime() && d.getTime() <= to.getTime()).length;

const daysBefore = (date: Date, days: number) => new Date(date.getTime() - days * DAY_MS);

/** Activities finished out of those set, as of a date: null when none were set. */
function completionRate(inputs: HolisticInputs, asOf: Date): number | null {
  const assigned = inputs.assigned.filter((d) => d.getTime() <= asOf.getTime()).length;
  if (assigned === 0) return null;
  const done = inputs.completions.filter((d) => d.getTime() <= asOf.getTime()).length;
  return Math.min(1, done / assigned);
}

/** One pillar's score as of a date. */
export function pillarScore(inputs: HolisticInputs, dimension: HolisticDimension, asOf: Date): number {
  let score = NEUTRAL + SWING * Math.tanh(netFor(inputs.signals, PILLAR_AREAS[dimension], asOf) / SQUASH);
  if (dimension === 'education') {
    const rate = completionRate(inputs, asOf);
    if (rate !== null) score += (rate - 0.5) * 16;
  }
  if (dimension === 'skills') {
    score += Math.min(8, countIn(inputs.completions, daysBefore(asOf, RECENT_DAYS), asOf));
  }
  return clamp(score);
}

export function dimensionScores(inputs: HolisticInputs, asOf: Date): DimensionScore[] {
  return HOLISTIC_DIMENSIONS.map((dimension) => ({ dimension, score: pillarScore(inputs, dimension, asOf) }));
}

/** The EHI: the mean of the five pillars. */
export function overallScore(dimensions: readonly DimensionScore[]): number {
  return clamp(dimensions.reduce((sum, d) => sum + d.score, 0) / dimensions.length);
}

export function scoreAt(inputs: HolisticInputs, asOf: Date): number {
  return overallScore(dimensionScores(inputs, asOf));
}

// ───────────────────────────── Time series ─────────────────────────────

/** The instant a business date ("YYYY-MM-DD", Asia/Kolkata) begins. */
const startOfDay = (date: string) => new Date(`${date}T00:00:00+05:30`);

const endOfMonth = (month: string) => new Date(startOfDay(monthBounds(month).nextFirst).getTime() - 1);

/** Indian school years run April to March: "2026-10-24" is in "2026–27". Returns the start year. */
export function schoolYearStart(date: string): number {
  const [year, month] = date.split('-').map(Number) as [number, number];
  return month >= 4 ? year : year - 1;
}

export const schoolYearLabel = (start: number) => `${start}–${String(start + 1).slice(-2)}`;

function previousMonths(month: string, count: number): string[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/** The index at the end of each of the last six months (the current one so far), oldest first. */
export function monthlyHistory(inputs: HolisticInputs, now: Date, createdAt: Date): HolisticMonth[] {
  const first = businessMonth(createdAt);
  return previousMonths(businessMonth(now), MONTHS_SHOWN)
    .filter((month) => month >= first)
    .map((month) => ({ month, score: scoreAt(inputs, new Date(Math.min(endOfMonth(month).getTime(), now.getTime()))) }));
}

/** The index at the end of each school year the child has been here, the current one so far. */
export function yearlyHistory(inputs: HolisticInputs, now: Date, createdAt: Date): HolisticYear[] {
  const current = schoolYearStart(businessDate(now));
  const first = Math.max(schoolYearStart(businessDate(createdAt)), current - (MAX_YEARS - 1));
  const years: HolisticYear[] = [];
  for (let start = first; start <= current; start += 1) {
    const isCurrent = start === current;
    const yearEnd = new Date(startOfDay(`${start + 1}-04-01`).getTime() - 1);
    years.push({
      schoolYear: schoolYearLabel(start),
      grade: null, // the platform does not record year groups
      score: scoreAt(inputs, isCurrent ? now : yearEnd),
      isCurrent,
    });
  }
  return years;
}

// ───────────────────────────── Skills, strengths, playbook ─────────────────────────────

const SKILL_WINDOW_DAYS = 365;

/** One score per area the child has been noticed in over the last year, strongest first. */
export function skillProfile(inputs: HolisticInputs, asOf: Date): SkillScore[] {
  const from = daysBefore(asOf, SKILL_WINDOW_DAYS);
  const seen = new Set(inputs.signals.filter((s) => s.at > from && s.at <= asOf).map((s) => s.area));
  return [...seen]
    .map((area) => ({
      skill: SKILL_NAMES[area],
      score: clamp(NEUTRAL + 40 * Math.tanh(netFor(inputs.signals, [area], asOf) / 2.5)),
    }))
    .sort((a, b) => b.score - a.score || a.skill.localeCompare(b.skill));
}

/** Where the child shines: the areas with the most good noticed lately, and steady effort. */
export function strengthsOf(inputs: HolisticInputs, asOf: Date): string[] {
  const areas = Object.keys(SKILL_NAMES) as ObservationArea[];
  const strong = areas
    .map((area) => ({ area, net: netFor(inputs.signals, [area], asOf) }))
    .filter((a) => a.net > 0.5)
    .sort((a, b) => b.net - a.net)
    .slice(0, 4)
    .map((a) => SKILL_NAMES[a.area]);
  if (countIn(inputs.completions, daysBefore(asOf, RECENT_DAYS), asOf) >= 5) strong.push('Finishing what they start');
  return strong.slice(0, 5);
}

/** Gentle, practical next steps for a pillar — never clinical. */
const PILLAR_ACTIONS: Record<HolisticDimension, { grow: string; support: string; keep: string }> = {
  education: {
    grow: 'Ask what they are curious about this week and look it up together for ten minutes.',
    support: 'Pick one small learning task a day, finish it together, and celebrate when it is done.',
    keep: 'Keep a regular, calm time for learning; it is working.',
  },
  skills: {
    grow: 'Give them a chance to explain something they know to the family at dinner.',
    support: 'Let them practise out loud with someone they trust, then tell them one thing that went well.',
    keep: 'Keep encouraging them to speak up and share ideas.',
  },
  physical: {
    grow: 'Add a short walk, game or stretch to the day, and keep bedtimes regular.',
    support: 'Start with something fun and small, like fifteen minutes of play outside, and build from there.',
    keep: 'Keep active play and regular routines going.',
  },
  wellbeing: {
    grow: 'Ask “what was the best part of today?” at the end of each day and listen fully.',
    support: 'Set aside a quiet, unhurried moment each day to talk about how they are feeling.',
    keep: 'Keep making room to talk about feelings; they are clearly welcome.',
  },
  character: {
    grow: 'Notice and name kind or responsible choices as they happen.',
    support: 'Agree one simple expectation together and thank them each time they meet it.',
    keep: 'Keep naming the kind and responsible things you see.',
  },
};

// ───────────────────────────── Insights ─────────────────────────────

const GROWING = 'Evidence in this area has been getting stronger over the last month.';
const SLIPPING = 'This area has had less to celebrate over the last month, so it deserves a little extra attention.';
const SAME = 'About the same as a month ago.';
const NOTHING = 'Nothing has been noticed in this area yet, so it sits at the starting point of 50.';

function confidenceFor(points: number): Confidence {
  return points >= 5 ? 'high' : points >= 2 ? 'medium' : 'low';
}

function insightFor(inputs: HolisticInputs, dimension: HolisticDimension, score: number, before: number, asOf: Date): HolisticInsight {
  const delta = score - before;
  const trend: Trend = delta >= TREND_DELTA ? 'up' : delta <= -TREND_DELTA ? 'down' : 'steady';
  const from = daysBefore(asOf, RECENT_DAYS);
  const areas = PILLAR_AREAS[dimension];
  const recent = inputs.signals.filter((s) => areas.includes(s.area) && s.at > from && s.at <= asOf);
  const stars = recent.filter((s) => s.tone === 'positive').length;
  const finished = countIn(inputs.completions, from, asOf);
  const usesActivities = dimension === 'education' || dimension === 'skills';
  const points = recent.length + (usesActivities ? finished : 0);

  const factors: string[] = [];
  if (stars > 0) factors.push(`${stars} good ${stars === 1 ? 'thing' : 'things'} noticed in the last 3 months`);
  else if (recent.length > 0) factors.push('Teachers and family have shared what they have seen in the last 3 months');
  if (usesActivities && finished > 0) factors.push(`${finished} ${finished === 1 ? 'activity' : 'activities'} finished in the last 3 months`);
  if (factors.length === 0) factors.push('No observations or finished activities in the last 3 months');

  const label = DIMENSION_LABELS[dimension];
  const actions = PILLAR_ACTIONS[dimension];
  const hasEvidence = points > 0;
  const title = !hasEvidence
    ? `Still getting to know ${label.toLowerCase()}`
    : trend === 'up'
      ? `${label} is growing`
      : trend === 'down'
        ? `${label} could use some support`
        : `${label} is steady`;
  const why = !hasEvidence ? NOTHING : trend === 'up' ? GROWING : trend === 'down' ? SLIPPING : SAME;
  const action = trend === 'down' ? actions.support : trend === 'up' || score >= 65 ? actions.keep : actions.grow;

  return { dimension, trend, title, why, factors, action, confidence: confidenceFor(points) };
}

export function insightsOf(inputs: HolisticInputs, now: Date): HolisticInsight[] {
  const current = dimensionScores(inputs, now);
  const before = dimensionScores(inputs, daysBefore(now, 30));
  return current.map((d, i) => insightFor(inputs, d.dimension, d.score, before[i]!.score, now));
}

/** A short list of next steps: help for the weakest pillars first, then a nudge to celebrate. */
export function playbookOf(insights: readonly HolisticInsight[], dimensions: readonly DimensionScore[]): string[] {
  const scoreOf = (d: HolisticDimension) => dimensions.find((x) => x.dimension === d)?.score ?? NEUTRAL;
  const ordered = [...insights].sort((a, b) => scoreOf(a.dimension) - scoreOf(b.dimension));
  const steps = ordered.filter((i) => i.trend === 'down' || scoreOf(i.dimension) < 65).slice(0, 3).map((i) => i.action);
  steps.push('When you notice something good, add it as a star. Each one shows up in their Growth Moments.');
  return steps;
}

// ───────────────────────────── The whole index ─────────────────────────────

export function buildHolisticIndex(inputs: HolisticInputs, now: Date, createdAt: Date): HolisticIndex {
  const dimensions = dimensionScores(inputs, now);
  const insights = insightsOf(inputs, now);
  const upTo = (date: Date) => date.getTime() <= now.getTime();
  return {
    score: overallScore(dimensions),
    dimensions,
    history: yearlyHistory(inputs, now, createdAt),
    monthly: monthlyHistory(inputs, now, createdAt),
    skills: skillProfile(inputs, now),
    strengths: strengthsOf(inputs, now),
    playbook: playbookOf(insights, dimensions),
    insights,
    evidence: {
      stars: inputs.signals.filter((s) => s.tone === 'positive' && upTo(s.at)).length,
      activitiesCompleted: inputs.completions.filter(upTo).length,
    },
  };
}
