// Database access for Events & Competitions. No business rules.
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../shared/db/prisma.js';

const COMPETITION = {
  id: true,
  schoolId: true,
  title: true,
  level: true,
  status: true,
  scheduledOn: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { fullName: true } },
  nominations: {
    select: {
      studentId: true,
      student: { select: { fullName: true } },
      nominatedBy: { select: { fullName: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const satisfies Prisma.CompetitionSelect;
export type CompetitionRecord = Prisma.CompetitionGetPayload<{ select: typeof COMPETITION }>;

const NOMINATION = {
  studentId: true,
  nominatedById: true,
  createdAt: true,
  student: { select: { fullName: true } },
  nominatedBy: { select: { fullName: true } },
} as const satisfies Prisma.CompetitionNominationSelect;
export type NominationRecord = Prisma.CompetitionNominationGetPayload<{ select: typeof NOMINATION }>;

export function createCompetitionsRepository(db: Db) {
  return {
    async list(where: Prisma.CompetitionWhereInput, skip: number, take: number): Promise<{ items: CompetitionRecord[]; total: number }> {
      const [items, total] = await db.$transaction([
        db.competition.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take,
          select: COMPETITION,
        }),
        db.competition.count({ where }),
      ]);
      return { items, total };
    },

    find(id: string): Promise<CompetitionRecord | null> {
      return db.competition.findUnique({ where: { id }, select: COMPETITION });
    },

    schoolExists(id: string): Promise<boolean> {
      return db.school.count({ where: { id } }).then((n) => n > 0);
    },

    create(data: Prisma.CompetitionUncheckedCreateInput): Promise<CompetitionRecord> {
      return db.competition.create({ data, select: COMPETITION });
    },

    update(id: string, data: Prisma.CompetitionUncheckedUpdateInput): Promise<CompetitionRecord> {
      return db.competition.update({ where: { id }, data, select: COMPETITION });
    },

    async remove(id: string): Promise<void> {
      await db.competition.delete({ where: { id } });
    },

    /** Just enough to decide whether the caller made this nomination. */
    findNomination(competitionId: string, studentId: string): Promise<Pick<NominationRecord, 'nominatedById'> | null> {
      return db.competitionNomination.findUnique({
        where: { competitionId_studentId: { competitionId, studentId } },
        select: { nominatedById: true },
      });
    },

    /** Unique violations (the same student nominated twice) propagate. */
    createNomination(data: Prisma.CompetitionNominationUncheckedCreateInput): Promise<NominationRecord> {
      return db.competitionNomination.create({ data, select: NOMINATION });
    },

    async removeNomination(competitionId: string, studentId: string): Promise<void> {
      await db.competitionNomination.delete({ where: { competitionId_studentId: { competitionId, studentId } } });
    },
  };
}

export type CompetitionsRepository = ReturnType<typeof createCompetitionsRepository>;
