import { ValidationException } from '../domain/exceptions/app.exception.js';

export const MAX_PAGE_SIZE = 100;

export interface PageQuery {
  page: number;
  size: number;
  sort?: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  totalItems: number;
  totalPages: number;
}

export interface SortOrder {
  field: string;
  direction: 'asc' | 'desc';
}

export const toPage = <T>(
  items: T[],
  totalItems: number,
  q: Pick<PageQuery, 'page' | 'size'>,
): Page<T> => ({
  items,
  page: q.page,
  size: q.size,
  totalItems,
  totalPages: Math.ceil(totalItems / q.size),
});

/**
 * Parses `?sort=createdAt,desc` against a per-endpoint whitelist (README 5.2).
 * Unknown fields are rejected, never passed to the database.
 */
export function parseSort(
  sort: string | undefined,
  allowed: readonly string[],
  fallback: SortOrder,
): SortOrder {
  if (!sort) return fallback;
  const [field = '', dir = 'asc'] = sort.split(',');
  const direction = dir.toLowerCase();
  if (
    !allowed.includes(field) ||
    (direction !== 'asc' && direction !== 'desc')
  ) {
    throw new ValidationException([{ field: 'sort', code: 'OneOf' }]);
  }
  return { field, direction };
}
