import { describe, expect, it } from 'vitest';
import { truncateStack, filterAndSortErrors, getErrorStoreNames, type ErrorLogEntry } from '../src/lib/error-log.js';

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
