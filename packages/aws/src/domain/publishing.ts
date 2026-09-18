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
  | 'TARGET_NOT_BELOW_CURRENT';

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

export function checkRollbackTarget(
  current: CurrentPointer | undefined,
  targetVersion: number,
): PublishingResult<number> {
  if (current === undefined) return fail('NO_CURRENT_POINTER', 'nothing has been published, so there is nothing to roll back');
  const target = validateVersion(targetVersion);
  if (!target.ok) return target;
  if (target.value >= current.version) {
    return fail(
      'TARGET_NOT_BELOW_CURRENT',
      `rollback target ${String(target.value)} must be lower than the current version ${String(current.version)}`,
    );
  }
  return target;
}
