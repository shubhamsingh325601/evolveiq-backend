import { describe, expect, test } from 'vitest';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { CheckinRecord, CheckinValues, ConsentRecord, WellbeingRepository } from './wellbeing.repository.js';
import { createWellbeingService } from './wellbeing.service.js';
import { isRecordableDay, summariseCheckins, windowStart } from './wellness.js';

describe('recordable days', () => {
  test('today and the last 30 days are fine; tomorrow and 31 days back are not', () => {
    expect(isRecordableDay('2026-10-24', '2026-10-24')).toBe(true);
    expect(isRecordableDay('2026-09-24', '2026-10-24')).toBe(true);
    expect(isRecordableDay('2026-09-23', '2026-10-24')).toBe(false);
    expect(isRecordableDay('2026-10-25', '2026-10-24')).toBe(false);
  });

  test('the window of 7 days starts 6 days before today', () => {
    expect(windowStart('2026-10-24', 7)).toBe('2026-10-18');
    expect(windowStart('2026-03-02', 3)).toBe('2026-02-28');
  });
});

describe('summary', () => {
  test('is empty and honest with no check-ins', () => {
    expect(summariseCheckins([])).toEqual({
      days: 0,
      averageMood: null,
      averageEnergy: null,
      averageSleepMinutes: null,
      averageActiveMinutes: null,
    });
  });

  test('averages only the values that were given', () => {
    const summary = summariseCheckins([
      { day: '2026-10-23', mood: 4, energy: 3, sleepMinutes: 480, activeMinutes: null },
      { day: '2026-10-24', mood: 5, energy: 4, sleepMinutes: null, activeMinutes: 60 },
    ]);
    expect(summary).toEqual({ days: 2, averageMood: 4.5, averageEnergy: 3.5, averageSleepMinutes: 480, averageActiveMinutes: 60 });
  });
});

const NOW = new Date('2026-10-24T06:00:00.000Z');
const parent: Actor = { userId: 'p1', role: Role.Parent, schoolId: 's1' };
const student: Actor = { userId: 'c1', role: Role.Student, schoolId: 's1' };
const teacher: Actor = { userId: 't1', role: Role.Teacher, schoolId: 's1' };
const stranger: Actor = { userId: 'p2', role: Role.Parent, schoolId: 's1' };

function setup(initial: ConsentRecord[] = []) {
  const consents = new Map(initial.map((c) => [c.purpose, c]));
  const checkins = new Map<string, CheckinRecord>();
  const repository: WellbeingRepository = {
    consents: async () => [...consents.values()],
    setConsent: async (_student, purpose, granted) => {
      const record = { purpose, granted, decidedAt: NOW };
      consents.set(purpose, record);
      return record;
    },
    saveCheckin: async (_student, _by, day, values: CheckinValues) => {
      const record = { day: new Date(`${day}T00:00:00.000Z`), ...values };
      checkins.set(day, record);
      return record;
    },
    checkins: async (_student, since) => [...checkins.entries()].filter(([day]) => day >= since).map(([, record]) => record),
  };
  const students = { findStudent: async (actor: Actor) => (actor.userId === 'p2' ? null : { id: 'c1', fullName: 'Child', schoolId: 's1', createdAt: NOW }) };
  return createWellbeingService({ repository, students, now: () => NOW });
}

const granted = (purpose: ConsentRecord['purpose']): ConsentRecord => ({ purpose, granted: true, decidedAt: NOW });
const body = { mood: 4, energy: 3 };

describe('consent', () => {
  test('nothing decided means nothing granted', async () => {
    const consents = await setup().listConsents(parent, 'c1');
    expect(consents.map((c) => [c.purpose, c.granted, c.decidedAt])).toEqual([
      ['wellness_tracking', false, null],
      ['wellness_sharing', false, null],
    ]);
  });

  test('only a parent decides', async () => {
    await expect(setup().setConsent(student, 'c1', 'wellness_tracking', true)).rejects.toMatchObject({ statusCode: 403 });
    await expect(setup().setConsent(teacher, 'c1', 'wellness_tracking', true)).rejects.toMatchObject({ statusCode: 403 });
    await expect(setup().setConsent(stranger, 'c1', 'wellness_tracking', true)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('a parent can allow and later withdraw', async () => {
    const service = setup();
    expect((await service.setConsent(parent, 'c1', 'wellness_tracking', true)).granted).toBe(true);
    expect((await service.setConsent(parent, 'c1', 'wellness_tracking', false)).granted).toBe(false);
  });
});

describe('check-ins', () => {
  test('need the family to allow tracking first', async () => {
    await expect(setup().recordCheckin(student, 'c1', body)).rejects.toMatchObject({ statusCode: 403, code: 'CONSENT_REQUIRED' });
  });

  test('are recorded for today by default, and a second one replaces the first', async () => {
    const service = setup([granted('wellness_tracking')]);
    const first = await service.recordCheckin(student, 'c1', body);
    expect(first.day).toBe('2026-10-24');
    await service.recordCheckin(parent, 'c1', { mood: 2, energy: 2 });
    const list = await service.listCheckins(student, 'c1', { days: 30 });
    expect(list.checkins).toHaveLength(1);
    expect(list.checkins[0]).toMatchObject({ mood: 2, energy: 2 });
  });

  test('refuse a future day and one more than 30 days back', async () => {
    const service = setup([granted('wellness_tracking')]);
    await expect(service.recordCheckin(student, 'c1', { ...body, day: '2026-10-25' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.recordCheckin(student, 'c1', { ...body, day: '2026-09-01' })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('cannot be written by staff, or for someone else’s child', async () => {
    const service = setup([granted('wellness_tracking')]);
    await expect(service.recordCheckin(teacher, 'c1', body)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.recordCheckin(stranger, 'c1', body)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('staff see them only when the family also shares with the school', async () => {
    const trackingOnly = setup([granted('wellness_tracking')]);
    await trackingOnly.recordCheckin(student, 'c1', body);
    const hidden = await trackingOnly.listCheckins(teacher, 'c1', { days: 30 });
    expect(hidden).toMatchObject({ isTracking: true, isSharedWithSchool: false, isVisible: false, checkins: [] });

    const shared = setup([granted('wellness_tracking'), granted('wellness_sharing')]);
    await shared.recordCheckin(student, 'c1', body);
    expect((await shared.listCheckins(teacher, 'c1', { days: 30 })).checkins).toHaveLength(1);
  });

  test('sharing means nothing while tracking is off', async () => {
    const service = setup([granted('wellness_sharing')]);
    const list = await service.listCheckins(teacher, 'c1', { days: 30 });
    expect(list).toMatchObject({ isTracking: false, isSharedWithSchool: false, isVisible: false });
  });
});
