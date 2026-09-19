import { describe, expect, it } from 'vitest';
import * as core from '../../src/index.js';

describe('@featuresync/core public API', () => {
  it('exports only the client factories, the file source, defineFeature, parseSnapshot, the feature key pattern and error classes at runtime', () => {
    expect(Object.keys(core).sort()).toEqual([
      'ConfigurationError',
      'FEATURE_KEY_PATTERN',
      'FeatureDefinitionError',
      'SnapshotFileError',
      'SnapshotValidationError',
      'StartupError',
      'createFeatureFlags',
      'createFeatureFlagsFromEnv',
      'createFileSnapshotSource',
      'defineFeature',
      'parseSnapshot',
    ]);
  });
});
