// Business rules for school management. No HTTP, no SQL.
//
// Who sees which school: Platform Admins and Psychologists (who work across schools and filter
// the review queue by school) see every school; everyone else only their own. Another school
// looks exactly like a missing one (404). Only Platform Admins create and rename schools.
import { Errors } from '../../shared/errors/index.js';
import { buildPagination, type Pagination } from '../../shared/pagination/index.js';
import { Role, type Actor } from '../../shared/rbac/index.js';
import type { SchoolRecord, SchoolsRepository } from './schools.repository.js';
import type { ListSchoolsQuery, SchoolDto } from './schools.schemas.js';

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

// Shared with every list endpoint; re-exported for existing importers of this module.
export { buildPagination };

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

  async function getById(actor: Actor, id: string): Promise<SchoolDto> {
    const seesEverySchool = actor.role === Role.PlatformAdmin || actor.role === Role.Psychologist;
    if (!seesEverySchool && actor.schoolId !== id) throw Errors.notFound('School');
    const school = await repository.findById(id);
    if (!school) throw Errors.notFound('School');
    return toDto(school);
  }

  async function rename(id: string, input: { name: string }): Promise<SchoolDto> {
    const school = await repository.rename(id, normaliseName(input.name));
    if (!school) throw Errors.notFound('School');
    return toDto(school);
  }

  // Only an empty school can go (no accounts, no classes): one added by mistake, or never used.
  // Its notices go with it.
  async function remove(id: string): Promise<void> {
    const result = await repository.remove(id);
    if (result === 'missing') throw Errors.notFound('School');
    if (result === 'not_empty') {
      throw Errors.hasRecords('This school still has accounts or classes. Remove or move them first.');
    }
  }

  return { create, list, getById, rename, remove };
}

export type SchoolsService = ReturnType<typeof createSchoolsService>;
