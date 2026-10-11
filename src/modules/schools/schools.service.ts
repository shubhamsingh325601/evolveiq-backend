// Business rules for school management. No HTTP, no SQL.
import { Errors } from '../../shared/errors/index.js';
import type { SchoolRecord, SchoolsRepository } from './schools.repository.js';
import type { ListSchoolsQuery, Pagination, SchoolDto } from './schools.schemas.js';

function toDto(s: SchoolRecord): SchoolDto {
  return {
    id: s.id,
    name: s.name,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** Names are stored trimmed (the schema already rejected blank / control characters). */
function normaliseName(name: string): string {
  return name.trim();
}

export function buildPagination(page: number, limit: number, total: number): Pagination {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export function createSchoolsService(deps: { repository: SchoolsRepository }) {
  const { repository } = deps;

  async function create(input: { name: string }): Promise<SchoolDto> {
    return toDto(await repository.create(normaliseName(input.name)));
  }

  async function list(query: ListSchoolsQuery): Promise<{ schools: SchoolDto[]; pagination: Pagination }> {
    const { page, limit, sortBy, sortOrder, name } = query;
    const { items, total } = await repository.list({
      skip: (page - 1) * limit,
      take: limit,
      sortBy,
      sortOrder,
      nameContains: name,
    });
    return { schools: items.map(toDto), pagination: buildPagination(page, limit, total) };
  }

  async function getById(id: string): Promise<SchoolDto> {
    const school = await repository.findById(id);
    if (!school) throw Errors.notFound('School');
    return toDto(school);
  }

  async function rename(id: string, input: { name: string }): Promise<SchoolDto> {
    const school = await repository.rename(id, normaliseName(input.name));
    if (!school) throw Errors.notFound('School');
    return toDto(school);
  }

  return { create, list, getById, rename };
}

export type SchoolsService = ReturnType<typeof createSchoolsService>;
