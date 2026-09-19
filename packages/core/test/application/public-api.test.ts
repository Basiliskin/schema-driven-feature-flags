import { describe, expect, it } from 'vitest';
import * as core from '../../src/index.js';

describe('@featuresync/core public API', () => {
  it('exports only the client factories, the file source, defineFeature, parseSnapshot, the segment contract, the feature key pattern and error classes at runtime', () => {
    expect(Object.keys(core).sort()).toEqual([
      'ConfigurationError',
      'FEATURE_KEY_PATTERN',
      'FeatureDefinitionError',
      'MAX_SEGMENT_MEMBERS',
      'MAX_SEGMENT_MEMBER_LENGTH',
      'SEGMENT_SCHEMA_VERSION',
      'SegmentValidationError',
      'SnapshotFileError',
      'SnapshotValidationError',
      'StartupError',
      'createFeatureFlags',
      'createFeatureFlagsFromEnv',
      'createFileSnapshotSource',
      'defineFeature',
      'parseSegment',
      'parseSnapshot',
      'referencedSegmentKeys',
      'segmentKeySchema',
    ]);
  });
});
