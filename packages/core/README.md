# @featuresync/core

Local-first, schema-driven feature flag runtime. Flags are evaluated in memory from an immutable,
versioned snapshot; a failed or invalid update always keeps the previous snapshot.

## Local development — no AWS required

Point `FEATURESYNC_FILE` at a snapshot JSON file:

```env
FEATURESYNC_FILE=./feature-flags.json
```

```ts
import { createFeatureFlagsFromEnv, defineFeature } from '@featuresync/core';
import { z } from 'zod';

const paymentFlow = defineFeature({
  key: 'payment-flow',
  schema: z.object({ provider: z.enum(['stripe', 'adyen']), maxAmount: z.number() }),
  default: { provider: 'stripe', maxAmount: 1000 },
  context: z.object({ plan: z.enum(['free', 'pro', 'enterprise']) }),
});

const flags = createFeatureFlagsFromEnv({ definitions: [paymentFlow], watch: true });
await flags.ready();

flags.isEnabled('new-dashboard', { isEmployee: true });
flags.evaluate('payment-flow', { plan: 'enterprise' }).value; // { provider: 'adyen', maxAmount: 10000 }
```

- `createFeatureFlagsFromEnv()` throws `ConfigurationError` when `FEATURESYNC_FILE` is missing.
- `ready()` rejects with `StartupError` when the file is missing, not JSON, or not a valid snapshot.
- With `watch: true` the file is reloaded when it changes. Truncated or invalid writes are logged and
  ignored; the active snapshot stays in place. Call `close()` to stop watching.

To configure the source explicitly instead of through the environment:

```ts
import { createFeatureFlags, createFileSnapshotSource } from '@featuresync/core';

const flags = createFeatureFlags({
  source: createFileSnapshotSource({ path: './feature-flags.json', watch: true, debounceMs: 100 }),
  definitions: [paymentFlow],
});
```

## Example

[`examples/node-local`](../../examples/node-local) runs against a local snapshot file:

```sh
pnpm install
pnpm example:node-local
```
