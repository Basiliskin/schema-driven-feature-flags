export const PACKAGE_NAME = '@featuresync/core';

export { defineFeature, type ConfigOf, type ContextOf, type FeatureDefinition } from './domain/define-feature.js';
export {
  FeatureDefinitionError,
  SnapshotValidationError,
  type Result,
  type ValidationIssue,
} from './domain/errors.js';
export {
  evaluate,
  type EvaluateOptions,
  type EvaluationReason,
  type EvaluationResult,
} from './domain/evaluation/evaluate.js';
export type { BooleanFeature, ConfigFeature, Feature } from './domain/feature.js';
export type { BooleanRule, Condition, ConfigRule, OperatorExpression } from './domain/rule.js';
export { SNAPSHOT_SCHEMA_VERSION } from './domain/snapshot-contract.js';
export { parseSnapshot, type DeepReadonly, type ParseSnapshotOptions, type Snapshot } from './domain/snapshot.js';
