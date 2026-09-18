import { z } from 'zod';
import { defineFeature } from '../../src/domain/define-feature.js';

export const paymentFlow = defineFeature({
  key: 'payment-flow',
  schema: z.object({
    provider: z.enum(['stripe', 'adyen']),
    maxAmount: z.number(),
    require3ds: z.boolean(),
  }),
  default: { provider: 'stripe', maxAmount: 1000, require3ds: true },
  context: z.object({ plan: z.enum(['free', 'pro', 'enterprise']), country: z.string() }),
});

export const validSnapshot = () => ({
  schemaVersion: 1,
  environment: 'production',
  version: 44,
  createdAt: '2026-09-18T06:00:00.000Z',
  createdBy: 'dimitry',
  previousVersion: 43,
  reason: 'Enable new checkout',
  features: {
    'new-dashboard': {
      type: 'boolean',
      enabled: true,
      rules: [{ when: { isEmployee: true }, enabled: true }],
    },
    'payment-flow': {
      type: 'config',
      enabled: true,
      default: { provider: 'stripe', maxAmount: 1000, require3ds: true },
      rules: [
        { when: { plan: 'enterprise' }, value: { provider: 'adyen', maxAmount: 10000, require3ds: false } },
      ],
    },
  },
});
