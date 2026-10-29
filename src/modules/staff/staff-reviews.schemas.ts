// Zod schemas for staff reviews (client feedback, 29 Oct 2026: "rate and evaluate staff"). A
// School Admin rates each teacher 1–5 on five criteria once a month, with an optional comment.
import { z } from 'zod';
import { PAGE_QUERY_FIELDS, PaginationSchema } from '../../shared/pagination/index.js';

const Uuid = z.guid();
const Id = z.string().meta({ format: 'uuid' });
export const MonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM')
  .meta({ example: '2026-10', description: 'An Asia/Kolkata calendar month.' });
const FREE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*\S[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/u;

/** The criteria, in the order they are shown. Labels live in the frontend. */
export const REVIEW_CRITERIA = ['teaching', 'engagement', 'punctuality', 'teamwork', 'communication'] as const;
export type ReviewCriterion = (typeof REVIEW_CRITERIA)[number];

const Rating = z.number().int().min(1).max(5);

export const StaffMonthParamsSchema = z.strictObject({ staffId: Uuid, month: MonthSchema });

export const ListStaffReviewsQuerySchema = z.strictObject({
  ...PAGE_QUERY_FIELDS,
  month: MonthSchema.optional(),
  staffId: Uuid.optional(),
});
export type ListStaffReviewsQuery = z.output<typeof ListStaffReviewsQuerySchema>;

export const PutStaffReviewBodySchema = z
  .strictObject({
    teaching: Rating.meta({ description: 'Teaching quality.' }),
    engagement: Rating.meta({ description: 'Student engagement.' }),
    punctuality: Rating.meta({ description: 'Punctuality and discipline.' }),
    teamwork: Rating.meta({ description: 'Teamwork with colleagues.' }),
    communication: Rating.meta({ description: 'Communication with parents.' }),
    comment: z.string().max(1000).regex(FREE_TEXT, 'must not be blank or contain control characters').optional(),
  })
  .meta({ id: 'PutStaffReviewBody', description: 'Replaces the month’s review: a comment left out is cleared.' });
export type PutStaffReviewBody = z.output<typeof PutStaffReviewBodySchema>;

export const StaffReviewSchema = z
  .object({
    id: Id,
    staff: z.object({ id: Id, fullName: z.string() }),
    month: MonthSchema,
    ratings: z.object({
      teaching: Rating,
      engagement: Rating,
      punctuality: Rating,
      teamwork: Rating,
      communication: Rating,
    }),
    average: z.number().meta({ description: 'Mean of the five ratings, to one decimal.' }),
    comment: z.string().nullable(),
    reviewedBy: z.object({ fullName: z.string() }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'StaffReview' });
export type StaffReviewDto = z.output<typeof StaffReviewSchema>;

export const StaffReviewResponseSchema = z.object({ review: StaffReviewSchema }).meta({ id: 'StaffReviewResponse' });
export const StaffReviewListResponseSchema = z
  .object({
    reviews: z.array(StaffReviewSchema).meta({ description: 'Newest month first, then by name.' }),
    pagination: PaginationSchema,
  })
  .meta({ id: 'StaffReviewListResponse' });
