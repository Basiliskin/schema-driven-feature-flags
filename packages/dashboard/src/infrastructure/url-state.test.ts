import { describe, expect, it } from 'vitest';
import { HttpError } from './http-primitives.js';
import {
  MAX_FILTER_LENGTH,
  MAX_OPEN_KEYS,
  MAX_OPEN_KEY_LENGTH,
  NO_URL_STATE,
  parsePageNumber,
  parseUrlState,
  parseUrlStateFields,
  serialiseUrlState,
  withUrlState,
  type DashboardUrlState,
} from './url-state.js';

const parse = (query: string): DashboardUrlState => parseUrlState(new URLSearchParams(query));

describe('parsing the dashboard URL state', () => {
  it('defaults every key when the query string is empty', () => {
    expect(parse('')).toEqual({ filter: '', openFlags: [], page: 1, pageSize: 20 });
  });

  it('reads each key when it is present', () => {
    expect(parse('filter=checkout&open=a,b&page=3&pageSize=5')).toEqual({
      filter: 'checkout',
      openFlags: ['a', 'b'],
      page: 3,
      pageSize: 5,
    });
  });

  it('ignores query keys it does not own', () => {
    expect(parse('flagPage=2&sort=name')).toEqual({ filter: '', openFlags: [], page: 1, pageSize: 20 });
  });

  it('rejects a page number that is not a positive integer', () => {
    for (const value of ['abc', '3abc', '0', '-1', '']) {
      const thrown = (): DashboardUrlState => parse(`page=${encodeURIComponent(value)}`);
      expect(thrown).toThrow(HttpError);
      expect(thrown).toThrow('The page must be a positive integer.');
      try {
        thrown();
      } catch (error) {
        expect((error as HttpError).status).toBe(400);
      }
    }
  });

  it('rejects a page size that is not a positive integer', () => {
    const thrown = (): DashboardUrlState => parse('pageSize=none');
    expect(thrown).toThrow('The page size must be a positive integer.');
    try {
      thrown();
    } catch (error) {
      expect((error as HttpError).status).toBe(400);
    }
  });

  it('never throws on filter or open text, however malformed', () => {
    expect(parse('filter=%00%01&open=,,,').filter).toBe('\u0000\u0001');
    expect(parse('filter=%00%01&open=,,,').openFlags).toEqual([]);
  });

  it('trims the filter and caps its length without leaving trailing space', () => {
    expect(parse(`filter=${encodeURIComponent('   checkout   ')}`).filter).toBe('checkout');
    const long = 'x'.repeat(10_000);
    expect(parse(`filter=${long}`).filter).toHaveLength(MAX_FILTER_LENGTH);
    const spacedAtCap = `${'y'.repeat(MAX_FILTER_LENGTH - 1)} z`;
    expect(parse(`filter=${encodeURIComponent(spacedAtCap)}`).filter).toBe('y'.repeat(MAX_FILTER_LENGTH - 1));
  });

  it('drops empty and over-long open entries and trims the rest', () => {
    const tooLong = 'k'.repeat(MAX_OPEN_KEY_LENGTH + 1);
    const atCap = 'j'.repeat(MAX_OPEN_KEY_LENGTH);
    expect(parse(`open=${[' spaced ', '', tooLong, atCap].join(',')}`).openFlags).toEqual(['spaced', atCap]);
  });

  it('deduplicates open entries before applying the count cap', () => {
    expect(parse('open=a,a,a').openFlags).toEqual(['a']);
    const distinct = Array.from({ length: 500 }, (_entry, index) => `flag-${String(index)}`);
    const withRepeats = ['dup', 'dup', ...distinct];
    expect(parse(`open=${withRepeats.join(',')}`).openFlags).toHaveLength(MAX_OPEN_KEYS);
    expect(parse(`open=${withRepeats.join(',')}`).openFlags[1]).toBe('flag-0');
  });
});

describe('parsePageNumber on its own', () => {
  it('falls back only when the value is absent', () => {
    expect(parsePageNumber(null, 7, 'nope')).toBe(7);
    expect(parsePageNumber('12', 7, 'nope')).toBe(12);
  });
});

describe('serialising the dashboard URL state', () => {
  it('omits every key that holds its default', () => {
    expect(serialiseUrlState({})).toBe('');
    expect(serialiseUrlState({ filter: '', openFlags: [], page: 1, pageSize: 20 })).toBe('');
  });

  it('writes only the keys that differ from their default', () => {
    expect(serialiseUrlState({ page: 2 })).toBe('page=2');
    expect(serialiseUrlState({ pageSize: 5 })).toBe('pageSize=5');
    expect(serialiseUrlState({ openFlags: ['a', 'b'] })).toBe('open=a%2Cb');
  });

  it('percent-encodes filter text instead of emitting it raw', () => {
    expect(serialiseUrlState({ filter: 'a & b "c" <d>' })).toBe('filter=a%20%26%20b%20%22c%22%20%3Cd%3E');
  });

  it('round-trips a state carrying every key', () => {
    const state: DashboardUrlState = {
      filter: 'a & b "c" <d>',
      openFlags: ['checkout', 'x'.repeat(MAX_OPEN_KEY_LENGTH)],
      page: 4,
      pageSize: 5,
    };
    expect(parse(serialiseUrlState(state))).toEqual(state);
  });

  it('round-trips a filter sitting exactly on the length cap', () => {
    const state = { filter: 'f'.repeat(MAX_FILTER_LENGTH), openFlags: [], page: 1, pageSize: 20 };
    expect(parse(serialiseUrlState(state))).toEqual(state);
  });
});

describe('withUrlState', () => {
  it('returns the bare path when nothing needs carrying', () => {
    expect(withUrlState('/env/production/versions', {})).toBe('/env/production/versions');
  });

  it('appends the query string when there is one', () => {
    expect(withUrlState('/env/production/versions', { page: 3 })).toBe('/env/production/versions?page=3');
  });
});

describe('parseUrlStateFields', () => {
  const fields = (values: Record<string, string>): DashboardUrlState => parseUrlStateFields(new URLSearchParams(values));

  it('reads the same state a query string would', () => {
    expect(fields({ filter: 'dark', open: 'a,b', page: '3', pageSize: '5' })).toEqual({
      filter: 'dark',
      openFlags: ['a', 'b'],
      page: 3,
      pageSize: 5,
    });
  });

  it('falls back to the defaults when the fields are absent', () => {
    expect(fields({})).toEqual(NO_URL_STATE);
  });

  // A hidden field is as client-supplied as a URL, but failing here would turn a rejected write into an error page.
  it('falls back rather than throwing when a page field has been tampered with', () => {
    expect(fields({ page: '0', pageSize: 'lots' })).toEqual(NO_URL_STATE);
  });

  it('applies the same caps as the query-string path', () => {
    const state = fields({
      filter: 'f'.repeat(MAX_FILTER_LENGTH + 20),
      open: Array.from({ length: MAX_OPEN_KEYS + 5 }, (_, index) => `k${String(index)}`).join(','),
    });

    expect(state.filter).toHaveLength(MAX_FILTER_LENGTH);
    expect(state.openFlags).toHaveLength(MAX_OPEN_KEYS);
  });
});
