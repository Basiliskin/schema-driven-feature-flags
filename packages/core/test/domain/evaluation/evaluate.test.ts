import fc from 'fast-check';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../../../src/domain/evaluation/evaluate.js';
import { featureSchema, type Feature } from '../../../src/domain/feature.js';
import { conditionSchema } from '../../../src/domain/rule.js';

const context = z.object({ plan: z.enum(['free', 'pro']), seats: z.coerce.number() });

const seatsFeature = featureSchema.parse({
  type: 'config',
  enabled: true,
  default: 'small',
  rules: [{ when: { seats: { in: [10] } }, value: 'large' }],
});

describe('evaluate with a context schema', () => {
  it('returns the default with INVALID_CONTEXT when the context fails the schema', () => {
    expect(evaluate(seatsFeature, { plan: 'gold', seats: 10 }, { contextSchema: context })).toStrictEqual({
      value: 'small',
      enabled: true,
      reason: 'INVALID_CONTEXT',
    });
  });

  it('reports a boolean feature with rules as off on INVALID_CONTEXT', () => {
    const feature = featureSchema.parse({ type: 'boolean', enabled: true, rules: [{ when: {}, enabled: true }] });
    expect(evaluate(feature, {}, { contextSchema: context })).toStrictEqual({
      value: false,
      enabled: false,
      reason: 'INVALID_CONTEXT',
    });
  });

  it('evaluates rules against the parsed context', () => {
    expect(evaluate(seatsFeature, { plan: 'pro', seats: '10' }, { contextSchema: context })).toMatchObject({
      value: 'large',
      reason: 'RULE_MATCH',
    });
  });

  it('checks a disabled feature before validating context', () => {
    const disabled = { ...seatsFeature, enabled: false };
    expect(evaluate(disabled, null, { contextSchema: context }).reason).toBe('DISABLED');
  });
});

describe('evaluate robustness', () => {
  const planFeature = featureSchema.parse({
    type: 'boolean',
    enabled: true,
    rules: [{ when: { constructor: { notEquals: 'x' }, plan: { in: ['pro'] } }, enabled: true }],
  });

  it('ignores inherited properties of the context', () => {
    expect(evaluate(planFeature, { plan: 'pro' }).reason).toBe('DEFAULT');
  });

  it('treats non-finite numbers as unmatched', () => {
    const feature = featureSchema.parse({ type: 'boolean', enabled: true, rules: [{ when: { n: { notEquals: 1 } }, enabled: true }] });
    expect(evaluate(feature, { n: Number.NaN }).reason).toBe('DEFAULT');
    expect(evaluate(feature, { n: Number.POSITIVE_INFINITY }).reason).toBe('DEFAULT');
  });

  it('does not match an operator it does not know', () => {
    const feature = {
      type: 'boolean',
      enabled: true,
      rules: [{ when: { plan: { startsWith: 'p' } }, enabled: true }],
    } as unknown as Feature;
    expect(evaluate(feature, { plan: 'pro' }).reason).toBe('DEFAULT');
  });

  it('never throws and is deterministic for arbitrary contexts', () => {
    fc.assert(
      fc.property(fc.anything(), (arbitraryContext) => {
        const first = evaluate(planFeature, arbitraryContext);
        expect(evaluate(planFeature, arbitraryContext)).toStrictEqual(first);
        expect(['RULE_MATCH', 'DEFAULT']).toContain(first.reason);
      }),
    );
  });

  it('never throws against a context schema for arbitrary contexts', () => {
    fc.assert(
      fc.property(fc.anything(), (arbitraryContext) => {
        expect(['RULE_MATCH', 'DEFAULT', 'INVALID_CONTEXT']).toContain(
          evaluate(seatsFeature, arbitraryContext, { contextSchema: context }).reason,
        );
      }),
    );
  });

  it('gives the same result for the same attribute values regardless of object identity', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean())), (attributes) => {
        expect(evaluate(planFeature, { ...attributes })).toStrictEqual(evaluate(planFeature, structuredClone(attributes)));
      }),
    );
  });

  it('does not mutate its inputs', () => {
    const frozenContext = Object.freeze({ plan: 'pro', constructor: 'y' });
    expect(() => evaluate(Object.freeze(planFeature), frozenContext)).not.toThrow();
    expect(evaluate(planFeature, frozenContext)).toStrictEqual({
      value: true,
      enabled: true,
      reason: 'RULE_MATCH',
      ruleIndex: 0,
    });
  });
});

describe('condition schema', () => {
  it.each([
    ['two operators on one attribute', { plan: { equals: 'pro', notEquals: 'free' } }],
    ['no operator', { plan: {} }],
    ['an unknown operator', { plan: { startsWith: 'p' } }],
    ['an empty in list', { plan: { in: [] } }],
    ['a non-scalar operand', { plan: { equals: ['pro'] } }],
  ])('rejects %s', (_label, when) => {
    expect(conditionSchema.safeParse(when).success).toBe(false);
  });

  it('accepts a scalar shorthand and each operator', () => {
    expect(
      conditionSchema.safeParse({ a: 'x', b: { equals: 1 }, c: { notEquals: true }, d: { in: ['x', 2] } }).success,
    ).toBe(true);
  });
});
