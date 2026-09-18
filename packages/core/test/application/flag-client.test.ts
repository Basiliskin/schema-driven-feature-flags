import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createFeatureFlags } from '../../src/application/flag-client.js';
import { StartupError } from '../../src/application/errors.js';
import type { Logger } from '../../src/application/logger.port.js';
import type { SnapshotSource } from '../../src/application/snapshot-source.port.js';
import { SnapshotValidationError } from '../../src/domain/errors.js';
import { paymentFlow, validSnapshot } from '../domain/fixtures.js';

const snapshotAt = (version: number) => ({ ...validSnapshot(), version, previousVersion: null });

const fakeSource = (...responses: unknown[]) => {
  const load = vi.fn(() => {
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { load } satisfies SnapshotSource;
};

const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((settle) => (resolve = settle));
  return { promise, resolve };
};

const spyLogger = () => ({ error: vi.fn<Logger['error']>() });

const startedClient = async (source: SnapshotSource, logger: Logger = spyLogger()) => {
  const flags = createFeatureFlags({ source, definitions: [paymentFlow], logger });
  await flags.ready();
  return flags;
};

describe('createFeatureFlags', () => {
  describe('startup', () => {
    it('resolves ready() after the first valid load', async () => {
      const flags = await startedClient(fakeSource(snapshotAt(1)));

      expect(flags.version()).toBe(1);
    });

    it('rejects ready() with StartupError carrying the load failure', async () => {
      const failure = new Error('bucket unreachable');
      const flags = createFeatureFlags({ source: fakeSource(failure), logger: spyLogger() });

      await expect(flags.ready()).rejects.toBeInstanceOf(StartupError);
      await expect(flags.ready()).rejects.toMatchObject({ cause: failure });
      expect(flags.version()).toBeUndefined();
    });

    it('rejects ready() with the validation error as cause when the first snapshot is invalid', async () => {
      const flags = createFeatureFlags({ source: fakeSource({ version: 'nope' }), logger: spyLogger() });

      const error: unknown = await flags.ready().catch((failure: unknown) => failure);
      expect((error as StartupError).cause).toBeInstanceOf(SnapshotValidationError);
    });

    it('serves the fallback snapshot when allowStaleStartup is set and the source fails', async () => {
      const flags = createFeatureFlags({
        source: fakeSource(new Error('offline')),
        logger: spyLogger(),
        allowStaleStartup: true,
        fallbackSnapshot: snapshotAt(7),
      });

      await expect(flags.ready()).resolves.toBeUndefined();
      expect(flags.version()).toBe(7);
    });

    it('prefers the source over the fallback snapshot when both are valid', async () => {
      const flags = createFeatureFlags({
        source: fakeSource(snapshotAt(9)),
        allowStaleStartup: true,
        fallbackSnapshot: snapshotAt(7),
      });

      await flags.ready();
      expect(flags.version()).toBe(9);
    });

    it('still rejects ready() when allowStaleStartup has an invalid fallback', async () => {
      const logger = spyLogger();
      const flags = createFeatureFlags({
        source: fakeSource(new Error('offline')),
        logger,
        allowStaleStartup: true,
        fallbackSnapshot: {},
      });

      await expect(flags.ready()).rejects.toBeInstanceOf(StartupError);
      expect(logger.error).toHaveBeenCalledTimes(2);
    });

    it('logs through console.error when no logger is injected', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const flags = createFeatureFlags({ source: fakeSource(new Error('offline')) });

      await expect(flags.ready()).rejects.toBeInstanceOf(StartupError);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[featuresync]'), expect.any(Error));
      consoleError.mockRestore();
    });
  });

  describe('atomic swap', () => {
    it('keeps the previous snapshot and logs when a refresh is invalid', async () => {
      const logger = spyLogger();
      const flags = await startedClient(fakeSource(snapshotAt(1), { ...snapshotAt(2), features: 'broken' }), logger);

      await expect(flags.refresh()).resolves.toBe(false);

      expect(flags.version()).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(expect.any(String), expect.any(SnapshotValidationError));
    });

    it('keeps the previous snapshot when a refresh violates a feature definition schema', async () => {
      const wrongConfig = snapshotAt(2);
      wrongConfig.features['payment-flow'].default.maxAmount = 'lots' as never;
      const flags = await startedClient(fakeSource(snapshotAt(1), wrongConfig));

      await flags.refresh();

      expect(flags.version()).toBe(1);
      expect(flags.get('payment-flow').maxAmount).toBe(1000);
    });

    it('keeps the previous snapshot when a refresh load fails', async () => {
      const flags = await startedClient(fakeSource(snapshotAt(1), new Error('timeout')));

      await expect(flags.refresh()).resolves.toBe(false);
      expect(flags.version()).toBe(1);
    });

    it('swaps in a valid refresh as a whole', async () => {
      const next = snapshotAt(2);
      next.features['payment-flow'].default.maxAmount = 5000;
      const flags = await startedClient(fakeSource(snapshotAt(1), next));
      const before = flags.getAll();

      await expect(flags.refresh()).resolves.toBe(true);

      expect(flags.version()).toBe(2);
      expect(flags.get('payment-flow').maxAmount).toBe(5000);
      expect(before['payment-flow']).toMatchObject({ default: { maxAmount: 1000 } });
      expect(Object.isFrozen(flags.getAll())).toBe(true);
    });

    it('resolves concurrent refreshes to the latest started one, even when it finishes first', async () => {
      const slow = deferred();
      const fast = deferred();
      const source = { load: vi.fn().mockResolvedValueOnce(snapshotAt(1)) } satisfies SnapshotSource;
      const flags = await startedClient(source);
      source.load.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

      const older = flags.refresh();
      const newer = flags.refresh();
      fast.resolve(snapshotAt(3));
      await expect(newer).resolves.toBe(true);
      slow.resolve(snapshotAt(2));
      await expect(older).resolves.toBe(false);

      expect(flags.version()).toBe(3);
    });

    it('applies an older concurrent refresh when the newer one is invalid', async () => {
      const slow = deferred();
      const source = { load: vi.fn().mockResolvedValueOnce(snapshotAt(1)) } satisfies SnapshotSource;
      const flags = await startedClient(source);
      source.load.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({});

      const older = flags.refresh();
      await expect(flags.refresh()).resolves.toBe(false);
      slow.resolve(snapshotAt(2));

      await expect(older).resolves.toBe(true);
      expect(flags.version()).toBe(2);
    });
  });

  describe('push-based sources', () => {
    const pushSource = (initial: unknown) => {
      let listener: ((snapshot: unknown) => void) | undefined;
      const unsubscribe = vi.fn();
      const source = {
        load: vi.fn(() => Promise.resolve(initial)),
        subscribe: (onChange: (snapshot: unknown) => void) => {
          listener = onChange;
          return unsubscribe;
        },
      } satisfies SnapshotSource;
      return { source, unsubscribe, push: (snapshot: unknown) => listener?.(snapshot) };
    };

    it('validates and swaps pushed snapshots', async () => {
      const { source, push } = pushSource(snapshotAt(1));
      const flags = await startedClient(source);

      push(snapshotAt(2));
      expect(flags.version()).toBe(2);
      push({ invalid: true });
      expect(flags.version()).toBe(2);
    });

    it('unsubscribes on close', async () => {
      const { source, unsubscribe } = pushSource(snapshotAt(1));
      const flags = await startedClient(source);

      flags.close();
      flags.close();

      expect(unsubscribe).toHaveBeenCalledOnce();
    });
  });

  describe('queries', () => {
    it('never call the source', async () => {
      const source = fakeSource(snapshotAt(1));
      const flags = await startedClient(source);
      const loadsAfterStartup = source.load.mock.calls.length;

      for (let query = 0; query < 1000; query++) {
        flags.isEnabled('new-dashboard');
        flags.get('payment-flow');
        flags.evaluate('payment-flow', { plan: 'pro', country: 'DE' });
        flags.has('payment-flow');
        flags.getAll();
        flags.version();
      }

      expect(source.load).toHaveBeenCalledTimes(loadsAfterStartup);
    });

    it('return plain values, not promises, typed from the definitions', async () => {
      const flags = await startedClient(fakeSource(snapshotAt(1)));

      expectTypeOf(flags.isEnabled('new-dashboard')).toEqualTypeOf<boolean>();
      expectTypeOf(flags.get('payment-flow').provider).toEqualTypeOf<'stripe' | 'adyen'>();
      expectTypeOf<Parameters<typeof flags.evaluate>[1]>().toEqualTypeOf<{ plan: 'free' | 'pro' | 'enterprise'; country: string }>();
      // @ts-expect-error keys are limited to registered definitions
      flags.get('unknown-feature');
    });

    it('evaluates targeting rules with the definition context', async () => {
      const flags = await startedClient(fakeSource(snapshotAt(1)));

      expect(flags.evaluate('payment-flow', { plan: 'enterprise', country: 'DE' })).toEqual({
        value: { provider: 'adyen', maxAmount: 10000, require3ds: false },
        enabled: true,
        reason: 'RULE_MATCH',
        ruleIndex: 0,
      });
      expect(flags.evaluate('payment-flow', { plan: 'nope', country: 'DE' } as never).reason).toBe('INVALID_CONTEXT');
      expect(flags.isEnabled('new-dashboard', { isEmployee: true })).toBe(true);
      expect(flags.isEnabled('new-dashboard')).toBe(false);
      expect(flags.get('payment-flow').provider).toBe('stripe');
      expect(flags.has('new-dashboard')).toBe(true);
    });

    it('answer unknown keys with the definition default or false', async () => {
      const withoutPaymentFlow = snapshotAt(1);
      delete (withoutPaymentFlow.features as Partial<typeof withoutPaymentFlow.features>)['payment-flow'];
      const flags = await startedClient(fakeSource(withoutPaymentFlow));

      expect(flags.get('payment-flow')).toEqual(paymentFlow.default);
      expect(flags.evaluate('payment-flow', { plan: 'pro', country: 'DE' }).reason).toBe('NOT_FOUND');
      expect(flags.isEnabled('missing')).toBe(false);
      expect(flags.isEnabled('toString')).toBe(false);
      expect(flags.has('missing')).toBe(false);
    });

    it('answer from defaults before any snapshot is loaded', () => {
      const flags = createFeatureFlags({ source: { load: () => new Promise(() => undefined) }, definitions: [paymentFlow] });

      expect(flags.version()).toBeUndefined();
      expect(flags.getAll()).toEqual({});
      expect(flags.get('payment-flow')).toEqual(paymentFlow.default);
      expect(flags.isEnabled('new-dashboard')).toBe(false);
    });

    it('never throw when evaluation fails, and log instead', async () => {
      const logger = spyLogger();
      const flags = await startedClient(fakeSource(snapshotAt(1)), logger);
      const hostileContext = {
        get isEmployee(): never {
          throw new Error('getter exploded');
        },
      };

      expect(flags.isEnabled('new-dashboard', hostileContext)).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('new-dashboard'), expect.any(Error));
    });
  });
});
