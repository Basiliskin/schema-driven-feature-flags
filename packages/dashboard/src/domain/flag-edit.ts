import { parseSnapshot, type Result, type ValidationIssue } from '@featuresync/core';

export type FlagEdit =
  | { readonly kind: 'enabled'; readonly key: string; readonly enabled: boolean }
  | { readonly kind: 'default'; readonly key: string; readonly defaultJson: string };

export interface FlagEditMeta {
  readonly baseVersion: number;
  readonly createdBy: string;
  readonly reason: string;
  readonly now: Date;
}

export type FlagEditFailure =
  | { readonly kind: 'UNKNOWN_FEATURE'; readonly key: string }
  | { readonly kind: 'DEFAULT_NOT_EDITABLE'; readonly key: string }
  | { readonly kind: 'INVALID_DEFAULT_JSON'; readonly message: string }
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
  const target = Object.hasOwn(features, edit.key) ? features[edit.key] : undefined;
  if (!isObject(target)) return { ok: false, error: { kind: 'UNKNOWN_FEATURE', key: edit.key } };

  const edited = editFeature(target, edit);
  if (!edited.ok) return edited;

  const next: JsonObject = {
    ...(base as JsonObject),
    version: meta.baseVersion + 1,
    previousVersion: meta.baseVersion,
    createdAt: meta.now.toISOString(),
    createdBy: meta.createdBy,
    reason: meta.reason,
    features: { ...features, [edit.key]: edited.value },
  };

  const validated = parseSnapshot(next);
  if (!validated.ok) {
    return { ok: false, error: { kind: 'INVALID_SNAPSHOT', issues: validated.error.issues.map(describeIssue) } };
  }
  return { ok: true, value: next };
}

function editFeature(feature: JsonObject, edit: FlagEdit): Result<JsonObject, FlagEditFailure> {
  if (edit.kind === 'enabled') return { ok: true, value: { ...feature, enabled: edit.enabled } };
  if (feature.type === 'boolean') return { ok: false, error: { kind: 'DEFAULT_NOT_EDITABLE', key: edit.key } };
  try {
    return { ok: true, value: { ...feature, default: JSON.parse(edit.defaultJson) as unknown } };
  } catch (error) {
    return { ok: false, error: { kind: 'INVALID_DEFAULT_JSON', message: (error as Error).message } };
  }
}

const describeIssue = (issue: ValidationIssue): string => `${issue.path}: ${issue.message}`;
