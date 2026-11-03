import { describe, expect, it } from 'vitest';
import { ValidationException } from '../domain/exceptions/app.exception.js';
import { etagOf, parseIfMatch } from './etag.js';

describe('etag', () => {
  it('formats and parses', () => {
    expect(etagOf(3)).toBe('"3"');
    expect(parseIfMatch('"3"')).toBe(3);
    expect(parseIfMatch('W/"7"')).toBe(7);
    expect(parseIfMatch('12')).toBe(12);
  });

  it('rejects missing or malformed values', () => {
    expect(() => parseIfMatch(undefined)).toThrowError(ValidationException);
    expect(() => parseIfMatch('"abc"')).toThrowError(ValidationException);
    expect(() => parseIfMatch('*')).toThrowError(ValidationException);
  });
});
