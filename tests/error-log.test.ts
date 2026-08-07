import { describe, expect, it } from 'vitest';
import { truncateStack, filterAndSortErrors, getErrorStoreNames, type ErrorLogEntry } from '../src/lib/error-log.js';
import { errorRef } from '../src/lib/error-reference.js';

describe('truncateStack', () => {
  it('returns short stacks unchanged', () => {
    expect(truncateStack('short stack', 2000)).toBe('short stack');
  });

  it('truncates a stack longer than the max and appends an ellipsis', () => {
    const long = 'a'.repeat(50);
    const result = truncateStack(long, 10);
    expect(result).toBe('a'.repeat(10) + '…');
    expect(result.length).toBe(11);
  });
});

function entry(overrides: Partial<ErrorLogEntry> = {}): ErrorLogEntry {
  return {
    id: Math.random().toString(36),
    source: 'server',
    message: 'oops',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('filterAndSortErrors', () => {
  it('keeps descending (server-provided) order by default', () => {
    const entries = [
      entry({ id: 'e1', createdAt: '2026-01-03T00:00:00.000Z' }),
      entry({ id: 'e2', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const result = filterAndSortErrors(entries, { sortDir: 'desc', source: [], storeSlug: [], severity: [] });
    expect(result.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('reverses to ascending when requested', () => {
    const entries = [
      entry({ id: 'e1', createdAt: '2026-01-03T00:00:00.000Z' }),
      entry({ id: 'e2', createdAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const result = filterAndSortErrors(entries, { sortDir: 'asc', source: [], storeSlug: [], severity: [] });
    expect(result.map((e) => e.id)).toEqual(['e2', 'e1']);
  });

  it('filters by source', () => {
    const entries = [entry({ id: 'e1', source: 'server' }), entry({ id: 'e2', source: 'client' })];
    const result = filterAndSortErrors(entries, { sortDir: 'desc', source: ['client'], storeSlug: [], severity: [] });
    expect(result.map((e) => e.id)).toEqual(['e2']);
  });

  it('filters by severity', () => {
    const entries = [
      entry({ id: 'e1', severity: 'critical' }),
      entry({ id: 'e2', severity: 'error' }),
      entry({ id: 'e3', severity: 'warning' }),
    ];
    const result = filterAndSortErrors(entries, { sortDir: 'desc', source: [], storeSlug: [], severity: ['critical'] });
    expect(result.map((e) => e.id)).toEqual(['e1']);
  });

  it('treats an entry with no severity as an unclassified server error, not as unmatched', () => {
    // Rows written before migration 0013 have the column default, and an entry built in code may
    // carry nothing at all. Dropping those from a filtered view would make the filter quietly HIDE
    // entries rather than narrow them — the one behaviour a triage screen must never have.
    const entries = [entry({ id: 'e1' }), entry({ id: 'e2', severity: 'warning' })];
    expect(filterAndSortErrors(entries, { sortDir: 'desc', source: [], storeSlug: [], severity: ['error'] })
      .map((e) => e.id)).toEqual(['e1']);
  });

  it('combines severity with the other filters rather than replacing them', () => {
    const entries = [
      entry({ id: 'e1', source: 'server', severity: 'critical' }),
      entry({ id: 'e2', source: 'client', severity: 'critical' }),
      entry({ id: 'e3', source: 'server', severity: 'warning' }),
    ];
    const result = filterAndSortErrors(entries, { sortDir: 'desc', source: ['server'], storeSlug: [], severity: ['critical'] });
    expect(result.map((e) => e.id)).toEqual(['e1']);
  });

  it('narrows to one entry by the code the alert mail printed', () => {
    // The mail's deep link. Landing on a 500-row list and being asked to find the one you were just
    // told about is the friction the reference code exists to remove.
    const entries = [
      entry({ id: '4f8c2a1e-9b3d-4c7f-8e2a-1d6b9f3c8e4a' }),
      entry({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
    ];
    const result = filterAndSortErrors(entries, { sortDir: 'desc', source: [], storeSlug: [], severity: [], ref: '4f8c2a1e' });
    expect(result.map((e) => e.id)).toEqual(['4f8c2a1e-9b3d-4c7f-8e2a-1d6b9f3c8e4a']);
  });

  it('accepts the code with or without its # and in any case', () => {
    // A person retyping it from a phone will not reproduce the punctuation, and a `#` in a URL is a
    // fragment that never reaches the server — so both spellings have to land.
    const entries = [entry({ id: '4F8C2A1E-9b3d-4c7f-8e2a-1d6b9f3c8e4a' })];
    for (const ref of ['#4f8c2a1e', '4f8c2a1e', '4F8C2A1E', ' 4f8c2a1e ']) {
      expect(filterAndSortErrors(entries, { sortDir: 'desc', source: [], storeSlug: [], severity: [], ref }))
        .toHaveLength(1);
    }
  });

  it('returns nothing for a code that has aged out, rather than everything', () => {
    // The honest answer. Falling back to the full list would look like the link worked.
    const entries = [entry({ id: '4f8c2a1e-9b3d-4c7f-8e2a-1d6b9f3c8e4a' })];
    expect(filterAndSortErrors(entries, { sortDir: 'desc', source: [], storeSlug: [], severity: [], ref: '00000000' }))
      .toEqual([]);
  });

  it('ignores an empty ref instead of filtering everything out', () => {
    const entries = [entry({ id: '4f8c2a1e-9b3d-4c7f-8e2a-1d6b9f3c8e4a' })];
    expect(filterAndSortErrors(entries, { sortDir: 'desc', source: [], storeSlug: [], severity: [], ref: '' }))
      .toHaveLength(1);
  });

  it('filters by store, excluding entries with no store at all', () => {
    const entries = [
      entry({ id: 'e1', storeSlug: 'store-a' }),
      entry({ id: 'e2', storeSlug: 'store-b' }),
      entry({ id: 'e3' }),
    ];
    const result = filterAndSortErrors(entries, { sortDir: 'desc', source: [], storeSlug: ['store-a'], severity: [] });
    expect(result.map((e) => e.id)).toEqual(['e1']);
  });
});

describe('the free-text search (owner, 2026-08-07: "I am missing a search by id here")', () => {
  const base = { sortDir: 'desc' as const, source: [], storeSlug: [], severity: [] };
  const UUID = '4f8c2a1e-9b3d-4c7f-8e2a-1d6b9f3c8e4a';
  const entries = [
    entry({ id: UUID, route: '/api/checkout', message: 'payment provider timed out', storeSlug: 'keramika', storeName: 'קרמיקה', statusCode: 500 }),
    entry({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', route: '/cart', message: 'render failed', storeSlug: 'tools-shop', source: 'client' }),
  ];
  const found = (q: string) => filterAndSortErrors(entries, { ...base, q }).map((e) => e.id);

  it('finds an entry by the SHORT code, which is the only id a person ever sees', () => {
    // The row prints it, the alert mail prints it, and a screenshot carries it. `errorRef` is where
    // that spelling is defined, so the search asks it rather than re-deriving the eight characters.
    expect(found(errorRef(UUID))).toEqual([UUID]);
  });

  it('finds it with or without the leading #', () => {
    // The `#` is how the code is PRINTED, not part of it — and it is what an owner pastes.
    expect(found('4f8c2a1e')).toEqual([UUID]);
    expect(found('#4f8c2a1e')).toEqual([UUID]);
  });

  it('finds it by the full uuid, which is what a log line or a database row carries', () => {
    expect(found(UUID)).toEqual([UUID]);
    expect(found('1d6b9f3c8e4a')).toEqual([UUID]);
  });

  it('also matches route, message, store and status — what an owner types after the id fails', () => {
    expect(found('/api/checkout')).toEqual([UUID]);
    expect(found('timed out')).toEqual([UUID]);
    expect(found('tools-shop')).toEqual(['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    expect(found('קרמיקה')).toEqual([UUID]);
    expect(found('500')).toEqual([UUID]);
  });

  it('is case-insensitive and ANDs its terms, so a second word narrows', () => {
    expect(found('PAYMENT TIMED')).toEqual([UUID]);
    expect(found('payment /cart')).toEqual([]);
  });

  it('leaves the list alone when the box is empty', () => {
    expect(found('')).toHaveLength(2);
    expect(found('   ')).toHaveLength(2);
    expect(filterAndSortErrors(entries, base)).toHaveLength(2);
  });

  it('composes with the other narrowings rather than replacing them', () => {
    expect(filterAndSortErrors(entries, { ...base, source: ['client'], q: 'render' }).map((e) => e.id))
      .toEqual(['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']);
    expect(filterAndSortErrors(entries, { ...base, source: ['server'], q: 'render' })).toEqual([]);
  });
});

describe('getErrorStoreNames', () => {
  it('returns each distinct store once, sorted by name', () => {
    const entries = [
      entry({ storeSlug: 'store-b', storeName: 'ב חנות' }),
      entry({ storeSlug: 'store-a', storeName: 'א חנות' }),
      entry({ storeSlug: 'store-a', storeName: 'א חנות' }),
      entry({}), // no store — excluded
    ];
    expect(getErrorStoreNames(entries)).toEqual([
      { slug: 'store-a', name: 'א חנות' },
      { slug: 'store-b', name: 'ב חנות' },
    ]);
  });
});
