import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const FEATURE_METADATA = 'featuresync:feature';

/** Gates a route handler, or every handler of a controller, behind a flag checked by `FeatureFlagGuard`. */
export const Feature = (key: string): CustomDecorator => SetMetadata(FEATURE_METADATA, key);
