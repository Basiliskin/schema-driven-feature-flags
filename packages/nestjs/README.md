# @featuresync/nestjs

NestJS module for the [`@featuresync/core`](../core/README.md) in-memory flag client. The module
builds one client from a `SnapshotSource`, waits for its first snapshot during bootstrap, and closes
it on application shutdown.

```sh
pnpm add @featuresync/nestjs @featuresync/core @nestjs/common @nestjs/core reflect-metadata rxjs
```

## FeatureSyncModule.forRoot

```ts
import { Module } from '@nestjs/common';
import { createFileSnapshotSource } from '@featuresync/core';
import { FeatureSyncModule } from '@featuresync/nestjs';

@Module({
  imports: [
    FeatureSyncModule.forRoot({
      source: createFileSnapshotSource({ path: './feature-flags.json' }),
    }),
  ],
})
export class AppModule {}
```

`forRoot` takes the same options as core's `createFeatureFlags` (`source`, `definitions`, `logger`,
…) plus the guard options below. Bootstrap rejects with core's `StartupError` when no valid snapshot
can be loaded. The module is global by default; pass `isGlobal: false` to make importing modules
opt in.

## FeatureSyncModule.forRootAsync

Build the client options from other providers, e.g. `ConfigService`:

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createFileSnapshotSource } from '@featuresync/core';
import { FeatureSyncModule } from '@featuresync/nestjs';

FeatureSyncModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    source: createFileSnapshotSource({ path: config.getOrThrow<string>('FEATURESYNC_FILE') }),
  }),
});
```

A factory that throws or rejects fails bootstrap with its own error.

## Injecting the client

The client is registered under the `FEATURE_FLAGS` token. Inject it with `@InjectFeatureFlags()`
(or `@Inject(FEATURE_FLAGS)`); injection by type does not work because `FeatureFlags` is an
interface.

```ts
import { Injectable } from '@nestjs/common';
import type { FeatureFlags } from '@featuresync/core';
import { InjectFeatureFlags } from '@featuresync/nestjs';

@Injectable()
export class DashboardService {
  constructor(@InjectFeatureFlags() private readonly flags: FeatureFlags) {}

  layout(user: { isEmployee: boolean }): string {
    return this.flags.isEnabled('new-dashboard', user) ? 'new' : 'classic';
  }
}
```

## @Feature and FeatureFlagGuard

`@Feature(key)` marks a route handler or a whole controller; `FeatureFlagGuard` rejects the request
when that flag is disabled or unknown. A handler's `@Feature` overrides its controller's. Routes
without `@Feature` pass.

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { Feature, FeatureFlagGuard } from '@featuresync/nestjs';

@Controller('dashboard')
@UseGuards(FeatureFlagGuard)
export class DashboardController {
  @Get()
  @Feature('new-dashboard')
  show(): string {
    return 'new dashboard';
  }
}
```

By default the guard evaluates without context and throws `NotFoundException`. Both are
configurable on `forRoot` and `forRootAsync`:

```ts
import { ForbiddenException } from '@nestjs/common';

FeatureSyncModule.forRoot({
  source: createFileSnapshotSource({ path: './feature-flags.json' }),
  contextFrom: (context) => context.switchToHttp().getRequest<{ user?: unknown }>().user,
  guardException: (key) => new ForbiddenException(`Feature ${key} is disabled`),
});
```

## @FeatureFlag

`@FeatureFlag(key, { fallback? })` runs a provider method only while the flag is on:

```ts
import { Injectable } from '@nestjs/common';
import { FeatureFlag } from '@featuresync/nestjs';

@Injectable()
export class ReportService {
  @FeatureFlag('new-dashboard', { fallback: (id: string) => `classic report ${id}` })
  async build(id: string): Promise<string> {
    return `new report ${id}`;
  }
}
```

- **Flag on:** the original method runs with the same `this` and arguments.
- **Flag off or unknown:** the method is **skipped and returns `undefined`**, or the fallback's
  result when a `fallback` is given. It does **not** throw. The fallback receives the same `this`
  and arguments. An `async` method still returns a Promise.
- The flag is evaluated **without context**, so only the flag's own `enabled` state applies; use the
  injected client when targeting rules need per-call context.
- The decorator uses the client of the **most recently initialised** `FeatureSyncModule`. Calling a
  decorated method before any app has initialised, or after that app has shut down, throws
  `FeatureSyncModule has not been initialised`. Run one Nest app with `FeatureSyncModule` per
  process; with several, the newest one wins.
- Metadata set on the method by decorators applied before `@FeatureFlag` is kept.
