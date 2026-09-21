import { describe, expect, it } from 'vitest';
import { filterFlags, type FilterableFlag } from '../../src/application/filter-flags.js';

const flag = (overrides: Partial<FilterableFlag> = {}): FilterableFlag => ({
  key: 'checkout-banner',
  type: 'boolean',
  enabled: true,
  ...overrides,
});

const checkout = flag();
const pricing = flag({ key: 'pricing-config', type: 'config', enabled: false });
const flags = [checkout, pricing];

describe('filtering flags with no usable filter text', () => {
  it('returns every flag, in order, for an empty filter', () => {
    expect(filterFlags(flags, '')).toEqual(flags);
  });

  it('returns every flag for a whitespace-only filter', () => {
    expect(filterFlags(flags, '   \t ')).toEqual(flags);
  });
});

describe('matching a single term', () => {
  it('matches on the flag key', () => {
    expect(filterFlags(flags, 'checkout')).toEqual([checkout]);
  });

  it('matches on the flag type', () => {
    expect(filterFlags(flags, 'boolean')).toEqual([checkout]);
  });

  it('matches mid-word inside a key, not only at word boundaries', () => {
    expect(filterFlags(flags, 'ckout-ban')).toEqual([checkout]);
  });

  it('matches across the boundary between key and type', () => {
    expect(filterFlags(flags, 'banner b')).toEqual([checkout]);
  });

  it('ignores the case of both the term and the flag', () => {
    expect(filterFlags([flag({ key: 'Checkout-Banner' })], 'CHECKOUT')).toHaveLength(1);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterFlags(flags, 'nothing-here')).toEqual([]);
  });
});

describe('matching the enabled state', () => {
  it("matches an enabled flag on 'on'", () => {
    expect(filterFlags([checkout], 'on')).toEqual([checkout]);
  });

  it("matches a disabled flag on 'off'", () => {
    expect(filterFlags([pricing], 'off')).toEqual([pricing]);
  });
});

describe('the two quirks kept from the browser rule', () => {
  it("keeps 'on' returning a flag that is off, when its key carries those letters", () => {
    const off = flag({ key: 'onboarding-banner', type: 'boolean', enabled: false });
    expect(filterFlags([off], 'on')).toEqual([off]);
  });

  it("keeps 'on' matching a key containing 'config', with no 'on' of its own anywhere else", () => {
    const config = flag({ key: 'pricing-config', type: 'config', enabled: false });
    expect(filterFlags([config], 'on')).toEqual([config]);
  });

  it("does not match 'off' against an enabled flag: the overlap runs one way only", () => {
    expect(filterFlags([checkout], 'off')).toEqual([]);
  });
});

describe('combining several terms', () => {
  it('requires every term to match the same flag', () => {
    expect(filterFlags(flags, 'checkout boolean')).toEqual([checkout]);
  });

  it('returns nothing when the terms match different flags', () => {
    expect(filterFlags(flags, 'checkout pricing')).toEqual([]);
  });

  it('treats runs of whitespace as one separator rather than an empty term', () => {
    expect(filterFlags(flags, '  checkout \t\n boolean  ')).toEqual([checkout]);
  });
});
