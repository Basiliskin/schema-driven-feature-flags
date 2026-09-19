import { FEATURE_KEY_PATTERN, parseSnapshot, type Result, type ValidationIssue } from '@featuresync/core';

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
  | { readonly kind: 'setRules'; readonly key: string; readonly rulesJson: string };

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
  | { readonly kind: 'INVALID_SNAPSHOT'; readonly issues: readonly string[] };

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  if (feature.type === 'boolean') return { ok: false, error: { kind: 'DEFAULT_NOT_EDITABLE', key: edit.key } };
  const defaultValue = parseJson(edit.defaultJson, 'INVALID_DEFAULT_JSON');
  return defaultValue.ok ? { ok: true, value: { ...feature, default: defaultValue.value } } : defaultValue;
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
 * changed in between: true when nothing the edit touches differs between the two. A create only needs the
 * key to still be free in both, and re-applying it reports FEATURE_EXISTS if someone else took it.
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
