import {
  Inject,
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OnApplicationShutdown,
  type OnModuleInit,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common';
import { createFeatureFlags, type FeatureDefinition, type FeatureFlags, type FeatureFlagsOptions } from '@featuresync/core';
import { bindFeatureFlagClient, unbindFeatureFlagClient } from './feature-flag.decorator.js';
import { FeatureFlagGuard, type FeatureGuardOptions } from './feature-flag.guard.js';
import { FEATURE_FLAGS, FEATURE_GUARD_OPTIONS } from './tokens.js';

const FEATURE_SYNC_OPTIONS = Symbol('FEATURE_SYNC_OPTIONS');

/** Options for {@link FeatureSyncModule.forRoot}: core's client options, guard options and module visibility. */
export type FeatureSyncModuleOptions<Defs extends readonly FeatureDefinition[] = readonly FeatureDefinition[]> =
  FeatureFlagsOptions<Defs> & FeatureGuardOptions & {
    /** Makes {@link FEATURE_FLAGS} injectable in every module without importing this one. Defaults to `true`. */
    readonly isGlobal?: boolean;
  };

/** Options for {@link FeatureSyncModule.forRootAsync}: core's client options built by a DI factory. */
export interface FeatureSyncAsyncOptions<Defs extends readonly FeatureDefinition[] = readonly FeatureDefinition[]>
  extends FeatureGuardOptions {
  /** Modules exporting the providers listed in `inject`. */
  readonly imports?: ModuleMetadata['imports'];
  /** Receives the `inject` providers in order. */
  readonly useFactory: (...args: never[]) => FeatureFlagsOptions<Defs> | Promise<FeatureFlagsOptions<Defs>>;
  readonly inject?: (InjectionToken | OptionalFactoryDependency)[];
  /** Makes {@link FEATURE_FLAGS} injectable in every module without importing this one. Defaults to `true`. */
  readonly isGlobal?: boolean;
}

type GuardOptionValues = { [K in keyof FeatureGuardOptions]: FeatureGuardOptions[K] | undefined };

const featureFlagsProvider: Provider = {
  provide: FEATURE_FLAGS,
  inject: [FEATURE_SYNC_OPTIONS],
  useFactory: async (options: FeatureFlagsOptions<readonly FeatureDefinition[]>) => {
    const flags = createFeatureFlags(options);
    try {
      await flags.ready();
    } catch (error) {
      flags.close();
      throw error;
    }
    return flags;
  },
};

/** Provides one ready {@link FeatureFlags} client for the application and closes it on shutdown. */
@Module({})
export class FeatureSyncModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(FEATURE_FLAGS) private readonly flags: FeatureFlags) {}

  /** Bootstrap rejects with core's `StartupError` when no valid snapshot is available. */
  static forRoot<const Defs extends readonly FeatureDefinition[] = []>(
    options: FeatureSyncModuleOptions<Defs>,
  ): DynamicModule {
    const { isGlobal, contextFrom, guardException, ...clientOptions } = options;
    return FeatureSyncModule.register(
      { provide: FEATURE_SYNC_OPTIONS, useValue: clientOptions },
      { contextFrom, guardException },
      isGlobal,
    );
  }

  /** Bootstrap rejects with the factory's own error, or with core's `StartupError` when no valid snapshot is available. */
  static forRootAsync<const Defs extends readonly FeatureDefinition[] = []>(
    options: FeatureSyncAsyncOptions<Defs>,
  ): DynamicModule {
    return {
      ...FeatureSyncModule.register(
        { provide: FEATURE_SYNC_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        { contextFrom: options.contextFrom, guardException: options.guardException },
        options.isGlobal,
      ),
      imports: options.imports ?? [],
    };
  }

  private static register(
    optionsProvider: Provider,
    guardOptions: GuardOptionValues,
    isGlobal = true,
  ): DynamicModule {
    return {
      module: FeatureSyncModule,
      global: isGlobal,
      providers: [
        optionsProvider,
        featureFlagsProvider,
        { provide: FEATURE_GUARD_OPTIONS, useValue: guardOptions },
        FeatureFlagGuard,
      ],
      exports: [FEATURE_FLAGS, FEATURE_GUARD_OPTIONS, FeatureFlagGuard],
    };
  }

  onModuleInit(): void {
    bindFeatureFlagClient(this.flags);
  }

  onApplicationShutdown(): void {
    unbindFeatureFlagClient(this.flags);
    this.flags.close();
  }
}
