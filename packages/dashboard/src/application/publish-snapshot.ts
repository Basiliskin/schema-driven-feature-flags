import type { NotifyErrorHandler, NotifyFailure } from '@featuresync/aws';
import type { BrowsePorts } from './browse-environment.js';
import { describeFailure, EDIT_CONFLICT, INVALID_JSON_MESSAGE, NOTIFY_FAILED_WARNING } from './error-messages.js';

export interface SnapshotWriter {
  publish(environment: string, snapshot: unknown, options?: { expectedCurrentVersion?: number }): Promise<number>;
  rollback(environment: string, targetVersion: number, options?: { actor?: string }): Promise<number>;
}

export interface WritePorts {
  /** Opened per request so a failed Change Notification is reported to that request alone. */
  openWriter(onNotifyError: NotifyErrorHandler): SnapshotWriter;
}

export type WriteOutcome =
  | { readonly kind: 'success'; readonly version: number; readonly message: string; readonly warning?: string }
  | {
      readonly kind: 'failure';
      readonly message: string;
      readonly issues: readonly string[];
      /** Set when the request itself was malformed, so the page answers 400 rather than the 422 a stale edit gets. */
      readonly invalidInput?: boolean;
      /** Set when another writer published first; `since` is the version the rejected edit was made against. */
      readonly conflict?: { readonly since: number };
    };

export async function write(
  ports: WritePorts,
  run: (writer: SnapshotWriter) => Promise<number>,
  describeSuccess: (version: number) => string,
): Promise<WriteOutcome> {
  const notifyFailures: NotifyFailure[] = [];
  const writer = ports.openWriter((_error, failure) => notifyFailures.push(failure));
  let version: number;
  try {
    version = await run(writer);
  } catch (error) {
    return { kind: 'failure', ...describeFailure(error) };
  }
  const message = describeSuccess(version);
  return notifyFailures.length > 0
    ? { kind: 'success', version, message, warning: NOTIFY_FAILED_WARNING }
    : { kind: 'success', version, message };
}

/** Reads the pointer again after a lost race, only to name the version that won. */
export type ConflictPorts = WritePorts & Pick<BrowsePorts, 'readCurrentVersion'>;

// Matched structurally so this layer never loads the aws runtime just for an instanceof check.
const publishReasonOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'S3PublishError'
    ? (error as { reason?: unknown }).reason
    : undefined;

const readPointerAfterFailure = async (ports: ConflictPorts, environment: string): Promise<number | undefined> => {
  try {
    return await ports.readCurrentVersion(environment);
  } catch {
    return undefined;
  }
};

/**
 * Publishes only if the Environment is still at `baseVersion`, so a change made on a stale page can't
 * silently overwrite someone else's. Losing that race is reported as a conflict the page can review.
 */
export async function publishExpecting(
  ports: ConflictPorts,
  environment: string,
  snapshot: unknown,
  baseVersion: number | undefined,
): Promise<WriteOutcome> {
  let publishReason: unknown;
  const outcome = await write(
    ports,
    async (writer) => {
      try {
        return await writer.publish(
          environment,
          snapshot,
          ...(baseVersion === undefined ? [] : [{ expectedCurrentVersion: baseVersion }]),
        );
      } catch (error) {
        publishReason = publishReasonOf(error);
        throw error;
      }
    },
    (version) => `Published version ${String(version)} to ${environment}.`,
  );
  if (
    baseVersion === undefined ||
    outcome.kind === 'success' ||
    (publishReason !== 'CONFLICT' && publishReason !== 'VERSION_EXISTS')
  ) {
    return outcome;
  }
  // Both mean another writer got in first: rollbacks now append a version, so VERSION_EXISTS is only a race.
  const current = await readPointerAfterFailure(ports, environment);
  return { kind: 'failure', message: EDIT_CONFLICT(current), issues: [], conflict: { since: baseVersion } };
}

/** `baseVersion` is the version the pasted draft started from; absent for an Environment's first version. */
export async function publishSnapshot(
  ports: ConflictPorts,
  environment: string,
  jsonText: string,
  baseVersion?: number,
): Promise<WriteOutcome> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(jsonText);
  } catch {
    return { kind: 'failure', message: INVALID_JSON_MESSAGE, issues: [] };
  }
  return publishExpecting(ports, environment, snapshot, baseVersion);
}

export async function rollbackSnapshot(
  ports: WritePorts,
  environment: string,
  targetVersion: number,
): Promise<WriteOutcome> {
  return write(
    ports,
    (writer) => writer.rollback(environment, targetVersion, { actor: 'dashboard' }),
    (version) => `Restored version ${String(targetVersion)} of ${environment} as version ${String(version)}.`,
  );
}
