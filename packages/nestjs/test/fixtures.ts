import { defineFeature, type SnapshotSource } from '@featuresync/core';
import { z } from 'zod';

export const paymentFlow = defineFeature({
  key: 'payment-flow',
  schema: z.object({ provider: z.enum(['stripe', 'adyen']), maxAmount: z.number() }),
  default: { provider: 'stripe', maxAmount: 1000 },
  context: z.object({ plan: z.enum(['free', 'pro', 'enterprise']) }),
});

export const snapshot = () => ({
  schemaVersion: 1,
  environment: 'test',
  version: 7,
  createdAt: '2026-09-18T06:00:00.000Z',
  createdBy: 'tests',
  previousVersion: 6,
  reason: 'fixture',
  features: {
    'new-dashboard': {
      type: 'boolean',
      enabled: true,
      rules: [{ when: { isEmployee: true }, enabled: true }],
    },
    'payment-flow': {
      type: 'config',
      enabled: true,
      default: { provider: 'stripe', maxAmount: 1000 },
      rules: [{ when: { plan: 'enterprise' }, value: { provider: 'adyen', maxAmount: 10000 } }],
    },
  },
});

export const staticSource = (raw: unknown = snapshot()): SnapshotSource => ({ load: () => Promise.resolve(raw) });

export const failingSource = (failure = new Error('bucket unreachable')): SnapshotSource => ({
  load: () => Promise.reject(failure),
});

export const silentLogger = { error: () => undefined };
