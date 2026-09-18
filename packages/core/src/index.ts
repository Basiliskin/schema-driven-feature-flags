export {
  createFeatureFlags,
  type FeatureFlags,
  type FeatureFlagsOptions,
  type FlagEvaluation,
  type FlagReason,
  type SnapshotFeatures,
} from './application/flag-client.js';
export { StartupError } from './application/errors.js';
export type { Logger } from './application/logger.port.js';
export type { SnapshotSource, Unsubscribe } from './application/snapshot-source.port.js';
export {
  ConfigurationError,
  createFeatureFlagsFromEnv,
  type FeatureFlagsFromEnvOptions,
} from './infrastructure/config-from-env.js';
export {
  createFileSnapshotSource,
  SnapshotFileError,
  type FileSnapshotSourceOptions,
  type SnapshotFileErrorReason,
} from './infrastructure/file-snapshot-source.js';
export { defineFeature, type ConfigOf, type ContextOf, type FeatureDefinition } from './domain/define-feature.js';
export {
  FeatureDefinitionError,
  SnapshotValidationError,
  type Result,
  type ValidationIssue,
} from './domain/errors.js';
export type { EvaluationReason, EvaluationResult } from './domain/evaluation/evaluate.js';
export type { BooleanFeature, ConfigFeature, Feature } from './domain/feature.js';
export type { BooleanRule, Condition, ConfigRule, OperatorExpression } from './domain/rule.js';
export type { DeepReadonly, Snapshot } from './domain/snapshot.js';
