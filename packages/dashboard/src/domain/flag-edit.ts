import {
  FEATURE_KEY_PATTERN,
  parseSnapshot,
  segmentKeySchema,
  type Result,
  type ValidationIssue,
} from '@featuresync/core';

export type FlagType = 'boolean' | 'config';

export type FlagEdit =
  | { readonly kind: 'enabled'; readonly key: string; readonly enabled: boolean }
  | { readonly kind: 'default'; readonly key: string; readonly defaultJson: string }
  | {
      readonly kind: 'create';
      readonly key: string;
      readonly type: FlagType;
      readonly enabled: boolean;
      readonly defaultJson?: string;
    }
  | { readonly kind: 'delete'; readonly key: string }
  | { readonly kind: 'setRules'; readonly key: string; readonly rulesJson: string }
  | {
      readonly kind: 'setRollout';
      readonly key: string;
      readonly ruleIndex: number;
      readonly percentage: number;
      readonly bucketBy: string;
      readonly salt: string;
    }
  | { readonly kind: 'removeRollout'; readonly key: string; readonly ruleIndex: number }
  | {
      readonly kind: 'attachSegment';
      readonly key: string;
      readonly segmentKey: string;
      readonly memberAttribute: string;
      /** Already decoded by the caller; used only when the flag is config-typed. */
      readonly value?: unknown;
    }
  | { readonly kind: 'detachSegment'; readonly key: string; readonly ruleIndex: number };

/** Authorship for the edited snapshot. The publisher stamps `version`, `previousVersion` and `createdAt`. */
export interface FlagEditMeta {
  readonly createdBy: string;
  readonly reason: string;
}

export type FlagEditFailure =
  | { readonly kind: 'UNKNOWN_FEATURE'; readonly key: string }
  | { readonly kind: 'DEFAULT_NOT_EDITABLE'; readonly key: string }
  | { readonly kind: 'INVALID_DEFAULT_JSON'; readonly message: string }
  | { readonly kind: 'INVALID_RULES_JSON'; readonly message: string }
  | { readonly kind: 'FEATURE_EXISTS'; readonly key: string }
  | { readonly kind: 'INVALID_KEY'; readonly key: string }
  | { readonly kind: 'INVALID_RULE_INDEX'; readonly key: string; readonly ruleIndex: number }
  | { readonly kind: 'INVALID_PERCENTAGE'; readonly percentage: number }
  | { readonly kind: 'INVALID_SEGMENT_KEY'; readonly segmentKey: string }
  | { readonly kind: 'INVALID_SNAPSHOT'; readonly issues: readonly string[] };

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SEGMENT_CAPABLE_SCHEMA_VERSION = 2;

/**
 * A schemaVersion 1 snapshot cannot represent a segment condition, so attaching one carries the whole
 * environment up to 2. The upgrade is additive — every valid v1 snapshot is a valid v2 snapshot — and it
 * is recomputed on each apply, so a replayed attach upgrades whatever snapshot it lands on.
 */
const schemaVersionUpgradeFor = (base: unknown, edit: FlagEdit): JsonObject =>
  edit.kind === 'attachSegment' && isObject(base) && base.schemaVersion === 1
    ? { schemaVersion: SEGMENT_CAPABLE_SCHEMA_VERSION }
    : {};

export function applyFlagEdit(
  rawSnapshotText: string,
  edit: FlagEdit,
  meta: FlagEditMeta,
): Result<JsonObject, FlagEditFailure> {
  const base: unknown = JSON.parse(rawSnapshotText);
  const features = isObject(base) && isObject(base.features) ? base.features : {};
  const nextFeatures = editFeatures(features, edit);
  if (!nextFeatures.ok) return nextFeatures;

  const next: JsonObject = {
    ...(base as JsonObject),
    ...schemaVersionUpgradeFor(base, edit),
    createdBy: meta.createdBy,
    reason: meta.reason,
    features: nextFeatures.value,
  };

  const validated = parseSnapshot(next);
  if (!validated.ok) {
    return { ok: false, error: { kind: 'INVALID_SNAPSHOT', issues: validated.error.issues.map(describeIssue) } };
  }
  return { ok: true, value: next };
}

function editFeatures(features: JsonObject, edit: FlagEdit): Result<JsonObject, FlagEditFailure> {
  const exists = Object.hasOwn(features, edit.key);
  if (edit.kind === 'create') {
    if (!FEATURE_KEY_PATTERN.test(edit.key)) return { ok: false, error: { kind: 'INVALID_KEY', key: edit.key } };
    if (exists) return { ok: false, error: { kind: 'FEATURE_EXISTS', key: edit.key } };
    const created = createFeature(edit);
    return created.ok ? { ok: true, value: { ...features, [edit.key]: created.value } } : created;
  }

  const target = exists ? features[edit.key] : undefined;
  if (!isObject(target)) return { ok: false, error: { kind: 'UNKNOWN_FEATURE', key: edit.key } };
  if (edit.kind === 'delete') {
    return { ok: true, value: Object.fromEntries(Object.entries(features).filter(([key]) => key !== edit.key)) };
  }
  const edited = editFeature(target, edit);
  return edited.ok ? { ok: true, value: { ...features, [edit.key]: edited.value } } : edited;
}

function createFeature(edit: Extract<FlagEdit, { kind: 'create' }>): Result<JsonObject, FlagEditFailure> {
  if (edit.type === 'boolean') return { ok: true, value: { type: 'boolean', enabled: edit.enabled } };
  const defaultValue = parseJson(edit.defaultJson ?? 'null', 'INVALID_DEFAULT_JSON');
  if (!defaultValue.ok) return defaultValue;
  return { ok: true, value: { type: 'config', enabled: edit.enabled, default: defaultValue.value } };
}

function editFeature(
  feature: JsonObject,
  edit: Exclude<FlagEdit, { kind: 'create' | 'delete' }>,
): Result<JsonObject, FlagEditFailure> {
  if (edit.kind === 'enabled') return { ok: true, value: { ...feature, enabled: edit.enabled } };
  if (edit.kind === 'setRules') {
    const rules = parseJson(edit.rulesJson, 'INVALID_RULES_JSON');
    return rules.ok ? { ok: true, value: { ...feature, rules: rules.value } } : rules;
  }
  if (edit.kind === 'setRollout' || edit.kind === 'removeRollout') return editRollout(feature, edit);
  if (edit.kind === 'attachSegment') return attachSegment(feature, edit);
  if (edit.kind === 'detachSegment') return detachSegment(feature, edit);
  if (feature.type === 'boolean') return { ok: false, error: { kind: 'DEFAULT_NOT_EDITABLE', key: edit.key } };
  const defaultValue = parseJson(edit.defaultJson, 'INVALID_DEFAULT_JSON');
  return defaultValue.ok ? { ok: true, value: { ...feature, default: defaultValue.value } } : defaultValue;
}

/** Mirrors the core rollout schema's two-decimal rule without the float error of `p * 100 % 1`. */
const hasAtMostTwoDecimals = (percentage: number): boolean =>
  Math.abs(percentage * 100 - Math.round(percentage * 100)) < 1e-9;

function editRollout(
  feature: JsonObject,
  edit: Extract<FlagEdit, { kind: 'setRollout' | 'removeRollout' }>,
): Result<JsonObject, FlagEditFailure> {
  if (edit.kind === 'setRollout') {
    const { percentage } = edit;
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100 || !hasAtMostTwoDecimals(percentage)) {
      return { ok: false, error: { kind: 'INVALID_PERCENTAGE', percentage } };
    }
  }

  const addressed = addressRule(feature, edit);
  if (!addressed.ok) return addressed;
  const { rules, rule } = addressed.value;

  let nextRule: JsonObject;
  if (edit.kind === 'removeRollout') {
    nextRule = Object.fromEntries(Object.entries(rule).filter(([field]) => field !== 'rollout'));
  } else {
    const { percentage, bucketBy, salt } = edit;
    nextRule = { ...rule, rollout: { percentage, bucketBy, salt } };
  }

  const nextRules = [...rules];
  nextRules[edit.ruleIndex] = nextRule;
  return { ok: true, value: { ...feature, rules: nextRules } };
}

interface AddressedRule {
  readonly rules: readonly unknown[];
  readonly rule: JsonObject;
}

/** The single index guard shared by every edit that addresses one existing rule by position. */
function addressRule(
  feature: JsonObject,
  edit: { readonly key: string; readonly ruleIndex: number },
): Result<AddressedRule, FlagEditFailure> {
  const invalid: Result<AddressedRule, FlagEditFailure> = {
    ok: false,
    error: { kind: 'INVALID_RULE_INDEX', key: edit.key, ruleIndex: edit.ruleIndex },
  };
  const rules = feature.rules;
  if (
    !Array.isArray(rules) ||
    !Number.isInteger(edit.ruleIndex) ||
    edit.ruleIndex < 0 ||
    edit.ruleIndex >= rules.length
  ) {
    return invalid;
  }
  const rule: unknown = rules[edit.ruleIndex];
  return isObject(rule) ? { ok: true, value: { rules: rules as unknown[], rule } } : invalid;
}

function attachSegment(
  feature: JsonObject,
  edit: Extract<FlagEdit, { kind: 'attachSegment' }>,
): Result<JsonObject, FlagEditFailure> {
  if (!segmentKeySchema.safeParse(edit.segmentKey).success) {
    return { ok: false, error: { kind: 'INVALID_SEGMENT_KEY', segmentKey: edit.segmentKey } };
  }
  const when = { [edit.memberAttribute]: { inSegment: edit.segmentKey } };
  const rule = feature.type === 'config' ? { when, value: edit.value ?? null } : { when, enabled: true };
  const rules = Array.isArray(feature.rules) ? (feature.rules as unknown[]) : [];
  return { ok: true, value: { ...feature, rules: [...rules, rule] } };
}

function detachSegment(
  feature: JsonObject,
  edit: Extract<FlagEdit, { kind: 'detachSegment' }>,
): Result<JsonObject, FlagEditFailure> {
  const addressed = addressRule(feature, edit);
  if (!addressed.ok) return addressed;
  return {
    ok: true,
    value: { ...feature, rules: addressed.value.rules.filter((_, index) => index !== edit.ruleIndex) },
  };
}

function parseJson(
  text: string,
  kind: 'INVALID_DEFAULT_JSON' | 'INVALID_RULES_JSON',
): Result<unknown, FlagEditFailure> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: { kind, message: (error as Error).message } };
  }
}

const describeIssue = (issue: ValidationIssue): string => `${issue.path}: ${issue.message}`;

/** The parts of a flag an edit reads or writes; for a delete, the whole flag. */
const touchedFields = (edit: Exclude<FlagEdit, { kind: 'create' }>): readonly string[] | 'all' => {
  switch (edit.kind) {
    case 'enabled':
      return ['enabled'];
    // A default only makes sense for a config flag, so the type is part of what it depends on.
    case 'default':
      return ['type', 'default'];
    case 'setRules':
    case 'setRollout':
    case 'removeRollout':
    case 'attachSegment':
    case 'detachSegment':
      return ['rules'];
    case 'delete':
      return 'all';
  }
};

const featuresIn = (snapshotText: string): JsonObject | undefined => {
  try {
    const parsed: unknown = JSON.parse(snapshotText);
    return isObject(parsed) && isObject(parsed.features) ? parsed.features : undefined;
  } catch {
    return undefined;
  }
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether an edit made against `baseText` can be replayed on `latestText` without overriding anything that
 * changed in between. The comparison is **field-granular, not flag-granular**: only the fields this edit
 * writes are compared, so two edits to the SAME flag touching DIFFERENT fields both land by design. This
 * supersedes the looser "replay when the edited feature is unchanged" wording recorded at horizon 16.
 *
 * Returns false (no replay) when:
 * - `baseText` or `latestText` does not parse as JSON, or has no object `features` map;
 * - for a non-create edit, the flag is absent or not an object in either snapshot — the deleted-meanwhile case.
 *
 * Otherwise:
 * - `create` replays when the key was absent in the BASE snapshot. It is deliberately not checked against
 *   the latest: re-applying the edit is what reports FEATURE_EXISTS if someone else took the key meanwhile.
 * - every other kind replays when its touched fields are equal between base and latest. Equality is string
 *   equality of `JSON.stringify` of each field, not an order-insensitive deep compare — a `rules` array
 *   reordered with the same members counts as changed.
 *
 * Touched fields, per `touchedFields`: `enabled` -> ['enabled']; `default` -> ['type', 'default'];
 * `setRules` / `setRollout` / `removeRollout` / `attachSegment` / `detachSegment` -> ['rules']; `delete` -> the whole flag entry.
 *
 * This function returns a boolean and knows nothing about transport. A false result is what leads the
 * calling use case to reject the stale edit, which the HTTP layer then renders as 422 Edit Conflict; an
 * edit whose own touched fields did not move is replayed and published instead.
 */
export function canReplayEdit(baseText: string, latestText: string, edit: FlagEdit): boolean {
  const before = featuresIn(baseText);
  const after = featuresIn(latestText);
  if (before === undefined || after === undefined) return false;
  if (edit.kind === 'create') return !Object.hasOwn(before, edit.key);
  const from = before[edit.key];
  const to = after[edit.key];
  if (!isObject(from) || !isObject(to)) return false;
  const touched = touchedFields(edit);
  if (touched === 'all') return sameJson(from, to);
  return touched.every((field) => sameJson(from[field], to[field]));
}
