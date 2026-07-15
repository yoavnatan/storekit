// Shared server-side pagination for the admin dashboard's list tabs — every
// tab paginates the same way (15/page, arrows, query-param driven) so
// AdminPager.astro and each tab's slice logic stay in lockstep.
export const ADMIN_PAGE_SIZE = 15;

export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
  total: number;
}

export function paginate<T>(items: T[], page: number, pageSize = ADMIN_PAGE_SIZE): Page<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page: safePage, totalPages, total };
}

export function parsePage(searchParams: URLSearchParams, key: string): number {
  const raw = parseInt(searchParams.get(key) ?? '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}
