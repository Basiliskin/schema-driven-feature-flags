import type { PendingChangeSet } from '../domain/pending-change-set.js';
import type { BrowsePorts } from './browse-environment.js';
import { type ConflictPorts, publishExpecting, type WriteOutcome } from './publish-snapshot.js';

export type DriftPorts = Pick<BrowsePorts, 'readCurrentVersion'>;

/** True once the Environment is no longer at the version the draft started from, whichever way it moved. */
export async function detectVersionDrift(
  ports: DriftPorts,
  environment: string,
  pending: PendingChangeSet,
): Promise<boolean> {
  return (await ports.readCurrentVersion(environment)) !== pending.baseVersion;
}

/**
 * Publishes the whole draft as one new version. Without `force` the publish expects the Base Version, so a
 * drifted draft is reported as a conflict; with it the expectation is skipped, which is "publish anyway".
 * Nothing is replayed onto the newer version.
 */
export async function publishPendingChangeSet(
  ports: ConflictPorts,
  environment: string,
  pending: PendingChangeSet,
  options: { readonly force: boolean },
): Promise<WriteOutcome> {
  return publishExpecting(ports, environment, pending.snapshot, options.force ? undefined : pending.baseVersion);
}

/** Discarding is only the caller ceasing to echo the draft, so it needs no ports and touches no storage. */
export const discardPendingChangeSet = (): PendingChangeSet | undefined => undefined;
