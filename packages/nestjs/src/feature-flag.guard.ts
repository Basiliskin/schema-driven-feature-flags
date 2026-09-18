import { Inject, Injectable, NotFoundException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FeatureFlags } from '@featuresync/core';
import { FEATURE_METADATA } from './feature.decorator.js';
import { FEATURE_FLAGS, FEATURE_GUARD_OPTIONS } from './tokens.js';

/** How `FeatureFlagGuard` evaluates a flag and what it throws when the flag is off. */
export interface FeatureGuardOptions {
  /** Builds the evaluation context for a request, e.g. from the authenticated user. */
  readonly contextFrom?: (context: ExecutionContext) => unknown;
  /** Error thrown for a disabled or unknown flag. Defaults to `NotFoundException`. */
  readonly guardException?: (key: string) => Error;
}

/** Rejects requests whose `@Feature` flag is disabled or unknown; routes without `@Feature` pass. */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(FEATURE_FLAGS) private readonly flags: FeatureFlags,
    @Inject(FEATURE_GUARD_OPTIONS) private readonly options: FeatureGuardOptions,
  ) {}

  canActivate(context: ExecutionContext): true {
    const key = this.reflector.getAllAndOverride<string | undefined>(FEATURE_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (key === undefined || this.flags.isEnabled(key, this.options.contextFrom?.(context))) {
      return true;
    }
    throw this.options.guardException?.(key) ?? new NotFoundException();
  }
}
