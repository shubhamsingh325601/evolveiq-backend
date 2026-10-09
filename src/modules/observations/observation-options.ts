// The observation value lists, defined ONCE. The stored values are the Postgres enums in
// prisma/schema.prisma (lead-confirmed, Oct 2026); this file adds their UI labels. Each map is
// typed against the generated enum, so a value added to the schema without a label (or a
// label for a value that doesn't exist) fails to compile.
import {
  DevelopmentArea,
  LearningBehaviourArea,
  ObservationArea,
  ObservationFrequency,
  ObservationLevel,
  ObservationStatus,
  ObservationWhen,
} from '../../generated/prisma/enums.js';

export { DevelopmentArea, LearningBehaviourArea, ObservationArea, ObservationFrequency, ObservationLevel, ObservationStatus, ObservationWhen };

export const OBSERVATION_AREA_LABELS: Readonly<Record<ObservationArea, string>> = Object.freeze({
  emotions: 'Emotions & feelings',
  behaviour: 'Behaviour',
  social: 'Friends & social',
  learning: 'Learning & focus',
  communication: 'Communication',
  physical: 'Physical & movement',
  routines: 'Sleep, eating & routines',
  other: 'Other',
});

export const OBSERVATION_WHEN_LABELS: Readonly<Record<ObservationWhen, string>> = Object.freeze({
  today: 'Today',
  this_week: 'This week',
  this_month: 'This month',
  over_a_month: 'More than a month ago',
});

export const OBSERVATION_FREQUENCY_LABELS: Readonly<Record<ObservationFrequency, string>> = Object.freeze({
  once: 'Just once',
  sometimes: 'Sometimes',
  often: 'Often',
  daily: 'Every day',
});

/** Teachers only. */
export const OBSERVATION_LEVEL_LABELS: Readonly<Record<ObservationLevel, string>> = Object.freeze({
  minor: 'Minor',
  moderate: 'Moderate',
  significant: 'Significant',
});

/** Teachers only. */
export const LEARNING_BEHAVIOUR_AREA_LABELS: Readonly<Record<LearningBehaviourArea, string>> = Object.freeze({
  attention: 'Attention & focus',
  participation: 'Class participation',
  following_instructions: 'Following instructions',
  task_completion: 'Finishing classwork & homework',
  organisation: 'Organisation',
  working_with_others: 'Working with others',
  self_control: 'Self-control in class',
  other: 'Other',
});

/** Psychologist review tag. There is deliberately no "other". Also the growth-area names. */
export const DEVELOPMENT_AREA_LABELS: Readonly<Record<DevelopmentArea, string>> = Object.freeze({
  managing_feelings: 'Managing feelings',
  social_skills: 'Friendships & social skills',
  communication: 'Communication',
  focus_attention: 'Focus & attention',
  self_control: 'Self-control',
  confidence: 'Confidence & self-esteem',
  resilience: 'Coping & resilience',
  independence: 'Independence & routines',
  learning_skills: 'Learning skills',
  motor_skills: 'Movement & coordination',
});

export const OBSERVATION_STATUS_LABELS: Readonly<Record<ObservationStatus, string>> = Object.freeze({
  pending: 'Pending',
  reviewed: 'Reviewed',
});

/** "value → label" lines for API documentation. */
export function describeOptions(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels).map(([value, label]) => `\`${value}\` = ${label}`).join(', ');
}
