import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineFeature, type ConfigOf, type ContextOf } from '../../src/domain/define-feature.js';
import { FeatureDefinitionError } from '../../src/domain/errors.js';
import { paymentFlow } from './fixtures.js';

describe('defineFeature', () => {
  it('keeps the key, schema and validated default', () => {
    expect(paymentFlow.key).toBe('payment-flow');
    expect(paymentFlow.default).toEqual({ provider: 'stripe', maxAmount: 1000, require3ds: true });
    expect(Object.isFrozen(paymentFlow)).toBe(true);
  });

  it('stores the schema output of the default', () => {
    const retries = defineFeature({ key: 'retries', schema: z.object({ count: z.number().default(3) }), default: {} });

    expect(retries.default).toEqual({ count: 3 });
  });

  it('rejects a default that breaks its schema, naming the path', () => {
    const define = () =>
      defineFeature({
        key: 'payment-flow',
        schema: z.object({ maxAmount: z.number() }),
        default: { maxAmount: 'lots' as unknown as number },
      });

    expect(define).toThrow(FeatureDefinitionError);
    expect(define).toThrow(/payment-flow[\s\S]*default\.maxAmount/);
  });

  it('infers the literal key, config and context types', () => {
    expectTypeOf(paymentFlow.key).toEqualTypeOf<'payment-flow'>();
    expectTypeOf<ConfigOf<typeof paymentFlow>>().toEqualTypeOf<{
      provider: 'stripe' | 'adyen';
      maxAmount: number;
      require3ds: boolean;
    }>();
    expectTypeOf<ContextOf<typeof paymentFlow>>().toEqualTypeOf<{
      plan: 'free' | 'pro' | 'enterprise';
      country: string;
    }>();
  });

  it('infers an empty context when none is declared', () => {
    const banner = defineFeature({ key: 'banner', schema: z.string(), default: 'hi' });

    expectTypeOf<ContextOf<typeof banner>>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf(banner.context).toEqualTypeOf<undefined>();
  });

  it('refuses defaults with unknown keys or wrong enum values at compile time', () => {
    const schema = z.object({ provider: z.enum(['stripe', 'adyen']) });

    expect(() =>
      // @ts-expect-error 'paypal' is not a valid provider
      defineFeature({ key: 'a', schema, default: { provider: 'paypal' } }),
    ).toThrow(FeatureDefinitionError);
    // @ts-expect-error unknown config key
    defineFeature({ key: 'b', schema, default: { provider: 'stripe', extra: 1 } });
  });
});
