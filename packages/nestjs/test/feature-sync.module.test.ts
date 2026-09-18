import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createFeatureFlags, StartupError, type FeatureFlags, type SnapshotSource } from '@featuresync/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAGS, FeatureSyncModule, InjectFeatureFlags, type FeatureSyncModuleOptions } from '../src/index.js';
import { failingSource, paymentFlow, silentLogger, snapshot, staticSource } from './fixtures.js';

@Injectable()
class DashboardService {
  constructor(@InjectFeatureFlags() readonly flags: FeatureFlags) {}
}

@Injectable()
class BillingService {
  constructor(@InjectFeatureFlags() readonly flags: FeatureFlags) {}
}

@Module({ providers: [BillingService] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest modules are declared by decorator alone
class BillingModule {}

const apps: { close(): Promise<void> }[] = [];

const bootstrap = async (options: FeatureSyncModuleOptions, imports: unknown[] = []) => {
  const moduleRef = await Test.createTestingModule({
    imports: [FeatureSyncModule.forRoot(options), ...(imports as [])],
    providers: [DashboardService],
  }).compile();
  await moduleRef.init();
  apps.push(moduleRef);
  return moduleRef;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('FeatureSyncModule.forRoot', () => {
  it('injects a client that is already ready', async () => {
    const app = await bootstrap({ source: staticSource(), logger: silentLogger });
    const { flags } = app.get(DashboardService);

    expect(flags.version()).toBe(7);
    expect(flags.isEnabled('new-dashboard', { isEmployee: true })).toBe(true);
    expect(flags.isEnabled('new-dashboard')).toBe(false);
  });

  it('answers exactly like a core client built from the same snapshot', async () => {
    const options = { source: staticSource(), definitions: [paymentFlow], logger: silentLogger } as const;
    const app = await bootstrap(options);
    const injected = app.get<FeatureFlags<typeof options.definitions>>(FEATURE_FLAGS);
    const direct = createFeatureFlags(options);
    await direct.ready();

    for (const context of [{}, { isEmployee: true }]) {
      expect(injected.isEnabled('new-dashboard', context)).toBe(direct.isEnabled('new-dashboard', context));
    }
    for (const plan of ['free', 'enterprise'] as const) {
      expect(injected.evaluate('payment-flow', { plan })).toEqual(direct.evaluate('payment-flow', { plan }));
    }
    expect(injected.get('payment-flow')).toEqual(direct.get('payment-flow'));
    expect(injected.evaluate('payment-flow', { plan: 'enterprise' }).value).toEqual({
      provider: 'adyen',
      maxAmount: 10000,
    });
  });

  it('passes the other client options through to core', async () => {
    const logger = { error: vi.fn() };
    const app = await bootstrap({
      source: failingSource(),
      logger,
      allowStaleStartup: true,
      fallbackSnapshot: snapshot(),
    });

    expect(app.get<FeatureFlags>(FEATURE_FLAGS).version()).toBe(7);
    expect(logger.error).toHaveBeenCalledWith('Snapshot load failed; keeping the active one', expect.any(Error));
  });

  it('fails bootstrap with StartupError and releases the source when no snapshot loads', async () => {
    const unsubscribe = vi.fn();
    const source: SnapshotSource = { ...failingSource(), subscribe: () => unsubscribe };

    const failure: unknown = await bootstrap({ source, logger: silentLogger }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StartupError);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('closes the client exactly once when the app closes', async () => {
    const app = await bootstrap({ source: staticSource(), logger: silentLogger });
    const close = vi.spyOn(app.get<FeatureFlags>(FEATURE_FLAGS), 'close');

    await app.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it('provides one client, visible to modules that do not import it by default', async () => {
    const app = await bootstrap({ source: staticSource(), logger: silentLogger }, [BillingModule]);

    expect(app.get(BillingService).flags).toBe(app.get(DashboardService).flags);
    expect(app.get(DashboardService).flags).toBe(app.get(FEATURE_FLAGS));
  });

  it('hides the client from other modules when isGlobal is false', async () => {
    const failure: unknown = await bootstrap({ source: staticSource(), logger: silentLogger, isGlobal: false }, [
      BillingModule,
    ]).catch((error: unknown) => error);

    expect(String(failure)).toMatch(/BillingService/);
  });
});
