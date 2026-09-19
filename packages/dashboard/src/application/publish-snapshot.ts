import type { NotifyErrorHandler, NotifyFailure } from '@featuresync/aws';
import { describeFailure, INVALID_JSON_MESSAGE, NOTIFY_FAILED_WARNING } from './error-messages.js';

export interface SnapshotWriter {
  publish(environment: string, snapshot: unknown, options?: { expectedCurrentVersion?: number }): Promise<number>;
  rollback(environment: string, targetVersion: number): Promise<number>;
}

export interface WritePorts {
  /** Opened per request so a failed Change Notification is reported to that request alone. */
  openWriter(onNotifyError: NotifyErrorHandler): SnapshotWriter;
}

export type WriteOutcome =
  | { readonly kind: 'success'; readonly version: number; readonly message: string; readonly warning?: string }
  | { readonly kind: 'failure'; readonly message: string; readonly issues: readonly string[] };

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

export async function publishSnapshot(ports: WritePorts, environment: string, jsonText: string): Promise<WriteOutcome> {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(jsonText);
  } catch {
    return { kind: 'failure', message: INVALID_JSON_MESSAGE, issues: [] };
  }
  return write(
    ports,
    (writer) => writer.publish(environment, snapshot),
    (version) => `Published version ${String(version)} to ${environment}.`,
  );
}

export async function rollbackSnapshot(
  ports: WritePorts,
  environment: string,
  targetVersion: number,
): Promise<WriteOutcome> {
  return write(
    ports,
    (writer) => writer.rollback(environment, targetVersion),
    (version) => `Rolled ${environment} back to version ${String(version)}.`,
  );
}
