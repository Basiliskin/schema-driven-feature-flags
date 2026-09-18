import { describe, expect, it } from 'vitest';
import * as core from '../../src/index.js';

describe('@featuresync/core public API', () => {
  it('exports only the client factory, defineFeature and error classes at runtime', () => {
    expect(Object.keys(core).sort()).toEqual([
      'FeatureDefinitionError',
      'SnapshotValidationError',
      'StartupError',
      'createFeatureFlags',
      'defineFeature',
    ]);
  });
});
