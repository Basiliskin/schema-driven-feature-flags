import type { FeatureFlags } from '@featuresync/core';

/** What a `@FeatureFlag` method does when its flag is off. */
export interface FeatureFlagOptions<Args extends unknown[] = never[], Result = unknown> {
  /** Called with the method's own `this` and arguments; its result replaces the method's. */
  readonly fallback?: (...args: Args) => Result;
}

let activeClient: FeatureFlags | undefined;

export const bindFeatureFlagClient = (flags: FeatureFlags): void => {
  activeClient = flags;
};

export const unbindFeatureFlagClient = (flags: FeatureFlags): void => {
  if (activeClient === flags) activeClient = undefined;
};

const currentClient = (): FeatureFlags => {
  if (activeClient === undefined) {
    throw new Error('FeatureSyncModule has not been initialised: @FeatureFlag methods run only while a Nest app is up');
  }
  return activeClient;
};

const isAsync = (fn: object): boolean => fn.constructor.name === 'AsyncFunction';

/**
 * Runs the method only while `key` is enabled. When it is off the method is skipped and returns
 * `undefined` or the fallback's result — it never throws. `async` methods still return a Promise.
 * Evaluates against the client of the most recently initialised `FeatureSyncModule`.
 */
export const FeatureFlag =
  (key: string, options: FeatureFlagOptions = {}) =>
  <T extends (...args: never[]) => unknown>(
    _target: object,
    _propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const original = descriptor.value as T;
    const skipped = (self: unknown, args: never[]): unknown => {
      const result = options.fallback?.apply(self, args);
      return isAsync(original) ? Promise.resolve(result) : result;
    };
    const wrapper = function (this: unknown, ...args: never[]): unknown {
      return currentClient().isEnabled(key) ? original.apply(this, args) : skipped(this, args);
    };
    Object.defineProperty(wrapper, 'name', { value: original.name });
    for (const metadataKey of Reflect.getOwnMetadataKeys(original)) {
      Reflect.defineMetadata(metadataKey, Reflect.getOwnMetadata(metadataKey, original), wrapper);
    }
    descriptor.value = wrapper as T;
  };
