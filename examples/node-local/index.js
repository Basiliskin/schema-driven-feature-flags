import { createFeatureFlagsFromEnv, defineFeature } from '@featuresync/core';
import { z } from 'zod';

const paymentFlow = defineFeature({
  key: 'payment-flow',
  schema: z.object({ provider: z.enum(['stripe', 'adyen']), maxAmount: z.number() }),
  default: { provider: 'stripe', maxAmount: 1000 },
  context: z.object({ plan: z.enum(['free', 'pro', 'enterprise']) }),
});

const flags = createFeatureFlagsFromEnv({ definitions: [paymentFlow] });
await flags.ready();

console.log(`snapshot version: ${String(flags.version())}`);
console.log(`new-dashboard for an employee: ${String(flags.isEnabled('new-dashboard', { isEmployee: true }))}`);
console.log(`new-dashboard for a customer: ${String(flags.isEnabled('new-dashboard', { isEmployee: false }))}`);
console.log('payment-flow on free:', flags.evaluate('payment-flow', { plan: 'free' }).value);
console.log('payment-flow on enterprise:', flags.evaluate('payment-flow', { plan: 'enterprise' }).value);

flags.close();
