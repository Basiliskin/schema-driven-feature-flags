import type { FeatureDefinition } from './define-feature.js';
import type { Feature } from './feature.js';
import { err, formatPath, ok, SnapshotValidationError, toIssues, type Result, type ValidationIssue } from './errors.js';
import { snapshotContract, type SnapshotData } from './snapshot-contract.js';

export type DeepReadonly<T> = T extends (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type Snapshot = DeepReadonly<SnapshotData>;

export interface ParseSnapshotOptions {
  readonly definitions?: readonly FeatureDefinition[];
}

export function parseSnapshot(
  input: unknown,
  options: ParseSnapshotOptions = {},
): Result<Snapshot, SnapshotValidationError> {
  const parsed = snapshotContract.safeParse(input);
  if (!parsed.success) return err(new SnapshotValidationError(toIssues(parsed.error.issues)));

  const issues = (options.definitions ?? []).flatMap((definition) =>
    checkAgainstDefinition(parsed.data.features[definition.key], definition),
  );
  if (issues.length > 0) return err(new SnapshotValidationError(issues));

  return ok(deepFreeze(parsed.data));
}

function checkAgainstDefinition(feature: Feature | undefined, definition: FeatureDefinition): ValidationIssue[] {
  if (feature === undefined) return [];
  const featurePath = ['features', definition.key];
  if (feature.type !== 'config') {
    return [{ path: formatPath([...featurePath, 'type']), message: 'Expected a config feature' }];
  }
  const check = (value: unknown, path: readonly PropertyKey[]): ValidationIssue[] => {
    const result = definition.schema.safeParse(value);
    return result.success ? [] : toIssues(result.error.issues, [...featurePath, ...path]);
  };
  return [
    ...check(feature.default, ['default']),
    ...feature.rules.flatMap((rule, index) => check(rule.value, ['rules', index, 'value'])),
  ];
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function referencedSegmentKeys(snapshot: Snapshot): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const feature of Object.values(snapshot.features)) {
    for (const rule of feature.rules) {
      for (const expected of Object.values(rule.when)) {
        if (typeof expected === 'object' && expected.inSegment !== undefined) {
          keys.add(expected.inSegment);
        }
      }
    }
  }
  return keys;
}
