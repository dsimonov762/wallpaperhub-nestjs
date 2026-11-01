import { describe, expect, it } from 'vitest';
import { ValidationException } from '../domain/exceptions/app.exception.js';
import { newTraceId, traceIdFromTraceparent } from './ids.js';
import { maskEmail, maskSecret } from './pii.js';
import { parseSort, toPage } from './pagination.js';
import { sha256Hex } from './hashing.js';

describe('pii', () => {
  it('masks emails and secrets', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    expect(maskEmail('nonsense')).toBe('***');
    expect(maskSecret('abcdefghijkl')).toBe('abcd***kl');
    expect(maskSecret('short')).toBe('***');
  });
});

describe('ids', () => {
  it('generates 32-hex trace ids', () => {
    expect(newTraceId()).toMatch(/^[\da-f]{32}$/);
  });
  it('parses traceparent', () => {
    const id = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(traceIdFromTraceparent(`00-${id}-00f067aa0ba902b7-01`)).toBe(id);
    expect(traceIdFromTraceparent('garbage')).toBeUndefined();
    expect(
      traceIdFromTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`),
    ).toBeUndefined();
  });
});

describe('pagination', () => {
  it('builds the response envelope', () => {
    expect(toPage(['a', 'b'], 45, { page: 1, size: 20 })).toEqual({
      items: ['a', 'b'],
      page: 1,
      size: 20,
      totalItems: 45,
      totalPages: 3,
    });
  });

  it('whitelists sort fields', () => {
    const fallback = { field: 'createdAt', direction: 'desc' as const };
    expect(parseSort(undefined, ['createdAt'], fallback)).toEqual(fallback);
    expect(parseSort('title,asc', ['title', 'createdAt'], fallback)).toEqual({
      field: 'title',
      direction: 'asc',
    });
    expect(() => parseSort('password,asc', ['title'], fallback)).toThrowError(
      ValidationException,
    );
    expect(() => parseSort('title,sideways', ['title'], fallback)).toThrowError(
      ValidationException,
    );
  });
});

describe('hashing', () => {
  it('computes sha256', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
