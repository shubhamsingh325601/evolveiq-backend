// Business rules for staff reviews. No HTTP, no SQL.
//
// Who: a School Admin rates the teachers of their own school, one review per teacher per month
//   (writing again replaces it), and can take a review back. A teacher reads only their own
//   reviews. Nobody else reaches this module. Reviews are private: the celebration wall shows
//   an honour, never a rating.
// When: the current month or an earlier one, never a future month.
import { Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import { businessMonth } from '../progress/business-time.js';
import type { StaffReviewRecord, StaffReviewsRepository } from './staff-reviews.repository.js';
import type { ListStaffReviewsQuery, PutStaffReviewBody, StaffReviewDto } from './staff-reviews.schemas.js';

const asMonthDate = (month: string) => new Date(`${month}-01T00:00:00.000Z`);

export function toReviewDto(review: StaffReviewRecord): StaffReviewDto {
  const ratings = {
    teaching: review.teaching,
    engagement: review.engagement,
    punctuality: review.punctuality,
    teamwork: review.teamwork,
    communication: review.communication,
  };
  const values = Object.values(ratings);
  return {
    id: review.id,
    staff: { id: review.staff.id, fullName: review.staff.fullName },
    month: review.month.toISOString().slice(0, 7),
    ratings,
    average: Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10,
    comment: review.comment,
    reviewedBy: { fullName: review.reviewer.fullName },
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

function adminSchoolOf(actor: Actor): string {
  if (actor.role !== Role.SchoolAdmin || actor.schoolId === null) throw Errors.forbidden();
  return actor.schoolId;
}

export function createStaffReviewsService(deps: { repository: StaffReviewsRepository; now: () => Date }) {
  const { repository, now } = deps;

  async function list(actor: Actor, query: ListStaffReviewsQuery): Promise<{ reviews: StaffReviewDto[]; pagination: Pagination }> {
    if (actor.schoolId === null) throw Errors.forbidden();
    let staffId = query.staffId;
    if (actor.role === Role.Teacher) {
      if (staffId !== undefined && staffId !== actor.userId) throw Errors.forbidden('Teachers can only read their own reviews.');
      staffId = actor.userId;
    } else if (actor.role !== Role.SchoolAdmin) {
      throw Errors.forbidden();
    }
    const { items, total } = await repository.list(
      {
        schoolId: actor.schoolId,
        ...(staffId !== undefined && { staffId }),
        ...(query.month !== undefined && { month: asMonthDate(query.month) }),
      },
      (query.page - 1) * query.limit,
      query.limit,
    );
    return { reviews: items.map(toReviewDto), pagination: buildPagination(query.page, query.limit, total) };
  }

  async function put(actor: Actor, staffId: string, month: string, body: PutStaffReviewBody): Promise<StaffReviewDto> {
    const schoolId = adminSchoolOf(actor);
    if (month > businessMonth(now())) throw Errors.validation([{ field: 'month', message: 'must not be in the future' }]);
    if (!(await repository.findTeacher(staffId, schoolId))) throw Errors.notFound('Teacher');
    const review = await repository.upsert(
      { schoolId, staffId, reviewerId: actor.userId, month: asMonthDate(month) },
      {
        teaching: body.teaching,
        engagement: body.engagement,
        punctuality: body.punctuality,
        teamwork: body.teamwork,
        communication: body.communication,
        comment: body.comment?.trim() || null,
      },
    );
    return toReviewDto(review);
  }

  async function remove(actor: Actor, staffId: string, month: string): Promise<void> {
    const schoolId = adminSchoolOf(actor);
    if (!(await repository.remove(staffId, asMonthDate(month), schoolId))) throw Errors.notFound('Staff review');
  }

  return { list, put, remove };
}

export type StaffReviewsService = ReturnType<typeof createStaffReviewsService>;
