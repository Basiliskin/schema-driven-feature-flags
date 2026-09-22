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

/**
 * How long a snapshot sitting above the Current Pointer is presumed to belong to a publish still in flight.
 * Past it, the publish that wrote it is taken to have died before moving the pointer, and the version is
 * skipped so the environment can publish again instead of wedging on `VERSION_EXISTS` forever.
 *
 * Skipping is safe whatever the truth: the skipping publish writes a *higher* version and moves the pointer
 * with `IfMatch`, so a publish that really was still in flight loses its pointer write with `CONFLICT`
 * rather than overwriting anything.
 */
export const DEFAULT_ORPHAN_GRACE_MS = 5 * 60 * 1000;

/** Whether a probed version that is already occupied may be skipped, and why not when it may not. */
export type OccupiedVersion =
  | { readonly verdict: 'SKIP' }
  | { readonly verdict: 'KEEP'; readonly message: string };

export interface OccupiedVersionInput {
  /** The occupied snapshot's LastModified, or `null` when S3 reported none. */
  readonly snapshotModified: Date | null;
  /** The Current Pointer's LastModified, or `undefined` when there is no pointer or it carries none. */
  readonly pointerModified: Date | undefined;
  readonly now: Date;
  readonly graceMs: number;
}

const secondsBetween = (ms: number): string => String(Math.round(Math.max(0, ms) / 1000));

/**
 * Decides whether an already-occupied version number can be stepped over.
 *
 * A snapshot older than the pointer's last move is a leftover from an old-style rollback. One that merely
 * predates the grace period is an orphan: the publish that wrote it never moved the pointer onto it, so
 * nothing will. Anything newer may still belong to a live publish and is left alone.
 *
 * `now` is the local clock while `snapshotModified` is S3's, so the grace period must comfortably exceed
 * any expected skew. Skew in the safe direction (local clock behind S3) only defers recovery.
 */
export function classifyOccupiedVersion({
  snapshotModified,
  pointerModified,
  now,
  graceMs,
}: OccupiedVersionInput): OccupiedVersion {
  if (snapshotModified === null) {
    return { verdict: 'KEEP', message: 'Exists with no LastModified, so a publish in flight cannot be ruled out' };
  }
  if (pointerModified !== undefined && snapshotModified.getTime() < pointerModified.getTime()) {
    return { verdict: 'SKIP' };
  }
  const ageMs = now.getTime() - snapshotModified.getTime();
  if (ageMs >= graceMs) return { verdict: 'SKIP' };
  return {
    verdict: 'KEEP',
    message:
      `Written ${secondsBetween(ageMs)}s ago by a publish that may still be in flight; ` +
      `it is stepped over as an orphan once it is ${secondsBetween(graceMs)}s old`,
  };
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
