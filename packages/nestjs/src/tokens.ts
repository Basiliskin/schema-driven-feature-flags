import { Inject } from '@nestjs/common';

/** DI token of the {@link FeatureFlags} client provided by `FeatureSyncModule`. */
export const FEATURE_FLAGS: unique symbol = Symbol('FEATURE_FLAGS');

/** Parameter decorator injecting the client registered under {@link FEATURE_FLAGS}. */
export const InjectFeatureFlags = (): PropertyDecorator & ParameterDecorator => Inject(FEATURE_FLAGS);

export const FEATURE_GUARD_OPTIONS = Symbol('FEATURE_GUARD_OPTIONS');
