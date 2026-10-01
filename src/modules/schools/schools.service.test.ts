// Service-level unit tests for schools: business rules with a mocked repository.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SchoolRecord, SchoolsRepository } from './schools.repository.js';
import { ListSchoolsQuerySchema } from './schools.schemas.js';
import { buildPagination, createSchoolsService } from './schools.service.js';
import { AppError } from '../../shared/errors/index.js';

const ID = '33333333-3333-4333-8333-333333333333';
const record = (over: Partial<SchoolRecord> = {}): SchoolRecord => ({
  id: ID,
  name: 'Sunrise Public School',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...over,
});

let repo: { [K in keyof SchoolsRepository]: ReturnType<typeof vi.fn> };
let service: ReturnType<typeof createSchoolsService>;

beforeEach(() => {
  repo = { create: vi.fn(), findById: vi.fn(), rename: vi.fn(), list: vi.fn() };
  service = createSchoolsService({ repository: repo as unknown as SchoolsRepository });
});

describe('create', () => {
  test('trims the name and returns an ISO-dated DTO', async () => {
    repo.create.mockResolvedValue(record());
    const school = await service.create({ name: '  Sunrise Public School  ' });
    expect(repo.create).toHaveBeenCalledWith('Sunrise Public School');
    expect(school).toEqual({
      id: ID,
      name: 'Sunrise Public School',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });
});

describe('getById', () => {
  test('returns the school', async () => {
    repo.findById.mockResolvedValue(record());
    expect((await service.getById(ID)).id).toBe(ID);
    expect(repo.findById).toHaveBeenCalledWith(ID);
  });

  test('missing school → typed 404 NOT_FOUND', async () => {
    repo.findById.mockResolvedValue(null);
    const err = await service.getById(ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: 'School not found.' });
  });
});

describe('rename', () => {
  test('trims and passes id + new name to the repository', async () => {
    repo.rename.mockResolvedValue(record({ name: 'New Name' }));
    const school = await service.rename(ID, { name: ' New Name ' });
    expect(repo.rename).toHaveBeenCalledWith(ID, 'New Name');
    expect(school.name).toBe('New Name');
  });

  test('missing school → typed 404 NOT_FOUND', async () => {
    repo.rename.mockResolvedValue(null);
    await expect(service.rename(ID, { name: 'X' })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  test('unexpected repository errors propagate (→ 500 in the error handler)', async () => {
    repo.rename.mockRejectedValue(new Error('connection reset'));
    await expect(service.rename(ID, { name: 'X' })).rejects.toThrow('connection reset');
  });
});

describe('list', () => {
  test('translates page/limit into database skip/take and passes sort + filter through', async () => {
    repo.list.mockResolvedValue({ items: [record()], total: 41 });
    const query = ListSchoolsQuerySchema.parse({ page: '3', limit: '20', sortBy: 'createdAt', sortOrder: 'desc', name: ' sun ' });
    const result = await service.list(query);
    expect(repo.list).toHaveBeenCalledWith({ skip: 40, take: 20, sortBy: 'createdAt', sortOrder: 'desc', nameContains: 'sun' });
    expect(result.pagination).toEqual({
      page: 3, limit: 20, total: 41, totalPages: 3, hasNextPage: false, hasPreviousPage: true,
    });
    expect(result.schools).toHaveLength(1);
  });

  test('defaults: page 1, limit 20, sorted by name ascending, no filter', async () => {
    repo.list.mockResolvedValue({ items: [], total: 0 });
    await service.list(ListSchoolsQuerySchema.parse({}));
    expect(repo.list).toHaveBeenCalledWith({ skip: 0, take: 20, sortBy: 'name', sortOrder: 'asc', nameContains: undefined });
  });
});

describe('buildPagination', () => {
  test.each([
    // page, limit, total → totalPages, hasNext, hasPrev
    [1, 20, 0, 0, false, false],
    [1, 20, 20, 1, false, false],
    [1, 20, 21, 2, true, false],
    [2, 20, 21, 2, false, true],
    [5, 10, 21, 3, false, true], // beyond the last page: empty page, still consistent metadata
  ])('page=%i limit=%i total=%i → totalPages=%i next=%s prev=%s', (page, limit, total, totalPages, next, prev) => {
    expect(buildPagination(page, limit, total)).toEqual({
      page, limit, total, totalPages, hasNextPage: next, hasPreviousPage: prev,
    });
  });
});
