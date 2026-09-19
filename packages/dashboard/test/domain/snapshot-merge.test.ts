import { describe, expect, it } from 'vitest';
import { applyMergeChoices, mergeFeatures } from '../../src/domain/snapshot-merge.js';

const on = { type: 'boolean', enabled: true };
const off = { type: 'boolean', enabled: false };

describe('mergeFeatures', () => {
  it('leaves out features nobody changed, even when key order differs', () => {
    const base = { a: { type: 'config', enabled: true, default: 1 } };
    expect(mergeFeatures(base, { a: { default: 1, enabled: true, type: 'config' } }, base)).toEqual([]);
  });

  it('takes a change made only in the latest version', () => {
    expect(mergeFeatures({ a: on }, { a: on }, { a: off })).toEqual([
      { key: 'a', status: 'theirs', base: on, mine: on, theirs: off },
    ]);
  });

  it('keeps a change made only in the draft', () => {
    expect(mergeFeatures({ a: on }, { a: off }, { a: on })[0]?.status).toBe('mine');
  });

  it('treats identical changes on both sides as agreed', () => {
    expect(mergeFeatures({ a: on }, { a: off }, { a: off })[0]?.status).toBe('same');
  });

  it('flags different changes on both sides as a conflict', () => {
    const config = (value: number) => ({ type: 'config', enabled: true, default: value });
    expect(mergeFeatures({ a: config(1) }, { a: config(2) }, { a: config(3) })[0]?.status).toBe('conflict');
  });

  it('handles deletes and additions on either side', () => {
    const merged = mergeFeatures({ gone: on, edited: on }, { edited: off, mine: on }, { gone: on, theirs: on });
    expect(merged.map(({ key, status }) => [key, status])).toEqual([
      ['edited', 'conflict'],
      ['gone', 'mine'],
      ['mine', 'mine'],
      ['theirs', 'theirs'],
    ]);
  });
});

describe('mergeFeatures, field by field', () => {
  const base = { type: 'config', enabled: false, default: { max: 3 }, rules: [] };

  it('combines changes to different fields of the same flag without a choice', () => {
    const mine = { ...base, default: { max: 5 } };
    const theirs = { ...base, enabled: true };
    const [entry] = mergeFeatures({ a: base }, { a: mine }, { a: theirs });
    expect(entry?.status).toBe('combined');
    expect(entry?.fields).toEqual([
      { field: 'default', status: 'mine', base: { max: 3 }, mine: { max: 5 }, theirs: { max: 3 } },
      { field: 'enabled', status: 'theirs', base: false, mine: false, theirs: true },
    ]);
  });

  it('is a conflict only on the field both sides changed differently', () => {
    const mine = { ...base, default: { max: 5 }, rules: [{ when: { plan: 'pro' } }] };
    const theirs = { ...base, default: { max: 9 }, enabled: true };
    const [entry] = mergeFeatures({ a: base }, { a: mine }, { a: theirs });
    expect(entry?.status).toBe('conflict');
    expect(entry?.fields?.map(({ field, status }) => [field, status])).toEqual([
      ['default', 'conflict'],
      ['enabled', 'theirs'],
      ['rules', 'mine'],
    ]);
  });

  it('merges fields added on either side', () => {
    const [entry] = mergeFeatures({ a: base }, { a: { ...base, description: 'x' } }, { a: { ...base, enabled: true } });
    expect(entry?.fields?.map(({ field, status }) => [field, status])).toEqual([
      ['description', 'mine'],
      ['enabled', 'theirs'],
    ]);
  });

  it('merges field by field a flag both sides added independently', () => {
    const [entry] = mergeFeatures({}, { a: { ...base, enabled: true } }, { a: { ...base, rules: [{ when: {} }] } });
    expect(entry?.status).toBe('conflict');
    expect(entry?.fields?.map(({ field, status }) => [field, status])).toEqual([
      ['default', 'same'],
      ['enabled', 'conflict'],
      ['rules', 'conflict'],
      ['type', 'same'],
    ]);
  });

  it('keeps a whole-flag choice when the sides disagree on the type', () => {
    const [entry] = mergeFeatures({ a: base }, { a: { ...base, default: 5 } }, { a: { type: 'boolean', enabled: true } });
    expect(entry?.status).toBe('conflict');
    expect(entry).not.toHaveProperty('fields');
  });

  it('keeps a whole-flag choice when one side deleted the flag', () => {
    const [entry] = mergeFeatures({ a: base }, { a: { ...base, enabled: true } }, {});
    expect(entry?.status).toBe('conflict');
    expect(entry).not.toHaveProperty('fields');
  });
});

describe('applyMergeChoices', () => {
  const limits = { type: 'config', enabled: false, default: { max: 3 }, rules: [] };
  const base = { limits, gone: on, extra: on };
  const mine = { limits: { ...limits, enabled: true, default: { max: 5 } }, gone: off, extra: on, added: on };
  const theirs = { limits: { ...limits, default: { max: 9 }, rules: [{ when: {} }] }, extra: off };
  const entries = mergeFeatures(base, mine, theirs);

  it('lists every conflict left without a choice', () => {
    expect(applyMergeChoices(mine, entries, {})).toEqual({ ok: false, missing: ['gone', 'limits.default'] });
  });

  it('applies whole-flag and per-field choices, defaulting one-sided changes to the side that made them', () => {
    const result = applyMergeChoices(mine, entries, { gone: 'theirs', limits: { default: 'theirs' } });
    expect(result).toEqual({
      ok: true,
      features: {
        limits: { type: 'config', enabled: true, default: { max: 9 }, rules: [{ when: {} }] },
        extra: off,
        added: on,
      },
    });
  });

  it('lets the operator override a preselected side', () => {
    const result = applyMergeChoices(mine, entries, { gone: 'mine', extra: 'mine', limits: { default: 'mine', rules: 'mine' } });
    expect(result).toEqual({ ok: true, features: { limits: mine.limits, gone: off, extra: on, added: on } });
  });
});
