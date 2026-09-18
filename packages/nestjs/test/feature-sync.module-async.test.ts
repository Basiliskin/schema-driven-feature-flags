import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StartupError, type FeatureFlags, type SnapshotSource } from '@featuresync/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAGS, FeatureSyncModule, InjectFeatureFlags, type FeatureSyncAsyncOptions } from '../src/index.js';
import { failingSource, silentLogger, staticSource } from './fixtures.js';

@Injectable()
class SnapshotConfig {
  readonly source = staticSource();
}

@Module({ providers: [SnapshotConfig], exports: [SnapshotConfig] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest modules are declared by decorator alone
class SnapshotConfigModule {}

@Injectable()
class BillingService {
  constructor(@InjectFeatureFlags() readonly flags: FeatureFlags) {}
}

@Module({ providers: [BillingService] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest modules are declared by decorator alone
class BillingModule {}

const apps: { close(): Promise<void> }[] = [];

const bootstrap = async (options: FeatureSyncAsyncOptions, imports: unknown[] = []) => {
  const moduleRef = await Test.createTestingModule({
    imports: [FeatureSyncModule.forRootAsync(options), ...(imports as [])],
  }).compile();
  await moduleRef.init();
  apps.push(moduleRef);
  return moduleRef;
};

const failureOf = (promise: Promise<unknown>) => promise.then(
  () => undefined,
  (error: unknown) => error,
);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('FeatureSyncModule.forRootAsync', () => {
  it('builds the options from a provider of an imported module', async () => {
    const factory = vi.fn((config: SnapshotConfig) => ({ source: config.source, logger: silentLogger }));

    const app = await bootstrap({ imports: [SnapshotConfigModule], inject: [SnapshotConfig], useFactory: factory });

    expect(factory).toHaveBeenCalledExactlyOnceWith(app.get(SnapshotConfig));
    expect(app.get<FeatureFlags>(FEATURE_FLAGS).version()).toBe(7);
  });

  it('awaits an async factory before creating the client', async () => {
    const app = await bootstrap({
      useFactory: () => Promise.resolve({ source: staticSource(), logger: silentLogger }),
    });

    expect(app.get<FeatureFlags>(FEATURE_FLAGS).isEnabled('new-dashboard', { isEmployee: true })).toBe(true);
  });

  it('calls a factory without inject with no arguments', async () => {
    const factory = vi.fn(() => ({ source: staticSource(), logger: silentLogger }));

    await bootstrap({ useFactory: factory });

    expect(factory).toHaveBeenCalledExactlyOnceWith();
  });

  it('fails bootstrap with the error the factory rejected with', async () => {
    const configError = new Error('SNAPSHOT_BUCKET is not set');

    const failure = await failureOf(bootstrap({ useFactory: () => Promise.reject(configError) }));

    expect(failure).toBe(configError);
  });

  it('fails bootstrap with StartupError and releases the source when no snapshot loads', async () => {
    const unsubscribe = vi.fn();
    const source: SnapshotSource = { ...failingSource(), subscribe: () => unsubscribe };

    const failure = await failureOf(bootstrap({ useFactory: () => ({ source, logger: silentLogger }) }));

    expect(failure).toBeInstanceOf(StartupError);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('closes the client exactly once when the app closes', async () => {
    const app = await bootstrap({ useFactory: () => ({ source: staticSource(), logger: silentLogger }) });
    const close = vi.spyOn(app.get<FeatureFlags>(FEATURE_FLAGS), 'close');

    await app.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it('is visible to modules that do not import it by default', async () => {
    const app = await bootstrap({ useFactory: () => ({ source: staticSource(), logger: silentLogger }) }, [
      BillingModule,
    ]);

    expect(app.get(BillingService).flags).toBe(app.get(FEATURE_FLAGS));
  });

  it('hides the client from other modules when isGlobal is false', async () => {
    const failure = await failureOf(
      bootstrap({ useFactory: () => ({ source: staticSource(), logger: silentLogger }), isGlobal: false }, [
        BillingModule,
      ]),
    );

    expect(String(failure)).toMatch(/can't resolve dependencies of the BillingService/i);
  });
});
