import {
  POINTER_SCHEMA_VERSION,
  environmentSchema,
  snapshotKeyFor,
  versionSchema,
  type CurrentPointer,
} from './current-pointer.js';

export type PublishingErrorReason =
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_VERSION'
  | 'NO_CURRENT_POINTER'
  | 'TARGET_IS_CURRENT';

export interface PublishingError {
  readonly reason: PublishingErrorReason;
  readonly message: string;
}

export type PublishingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PublishingError };

const fail = (reason: PublishingErrorReason, message: string): PublishingResult<never> => ({
  ok: false,
  error: { reason, message },
});

export const nextSnapshotVersion = (current: CurrentPointer | undefined): number =>
  current === undefined ? 1 : current.version + 1;

export const buildCurrentPointer = (environment: string, version: number): CurrentPointer =>
  Object.freeze({
    schemaVersion: POINTER_SCHEMA_VERSION,
    environment,
    version,
    snapshotKey: snapshotKeyFor(environment, version),
  });

export function validateEnvironmentName(input: string): PublishingResult<string> {
  const parsed = environmentSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return fail('INVALID_ENVIRONMENT', parsed.error.issues.map((issue) => issue.message).join('; '));
}

export function validateVersion(input: string | number): PublishingResult<number> {
  const version = typeof input === 'number' ? input : Number(input);
  // Snapshot keys are built with String(version), so only the canonical decimal spelling names a real key.
  const canonical = typeof input === 'number' || String(version) === input;
  if (canonical && versionSchema.safeParse(version).success) return { ok: true, value: version };
  return fail('INVALID_VERSION', `version must be a positive decimal integer, got ${JSON.stringify(input)}`);
}

/** A rollback may target any valid version except the current one; whether its snapshot exists is checked in S3. */
export interface RollbackTarget {
  readonly targetVersion: number;
  readonly currentVersion: number;
}

export function checkRollbackTarget(
  current: CurrentPointer | undefined,
  targetVersion: number,
): PublishingResult<RollbackTarget> {
  if (current === undefined) return fail('NO_CURRENT_POINTER', 'nothing has been published, so there is nothing to roll back');
  const target = validateVersion(targetVersion);
  if (!target.ok) return target;
  if (target.value === current.version) {
    return fail('TARGET_IS_CURRENT', `version ${String(target.value)} is already the current version`);
  }
  return { ok: true, value: { targetVersion: target.value, currentVersion: current.version } };
}

export interface StampMeta {
  readonly version: number;
  readonly previousVersion: number | null;
  readonly now: Date;
}

/**
 * Sets the version metadata the publisher owns. Every other field, and the position of every key, is kept as
 * given, so the stored body differs from the input only in these three values.
 */
export const stampSnapshot = (raw: Readonly<Record<string, unknown>>, meta: StampMeta): Record<string, unknown> => ({
  ...raw,
  version: meta.version,
  previousVersion: meta.previousVersion,
  createdAt: meta.now.toISOString(),
});

export interface RollbackMeta {
  readonly targetVersion: number;
  readonly createdBy: string;
}

/** The body a rollback publishes before stamping: the target's snapshot, with rollback authorship. */
export const buildRollbackSnapshot = (
  source: Readonly<Record<string, unknown>>,
  meta: RollbackMeta,
): Record<string, unknown> => ({
  ...source,
  createdBy: meta.createdBy,
  reason: `Rollback to v${String(meta.targetVersion)}`,
});
