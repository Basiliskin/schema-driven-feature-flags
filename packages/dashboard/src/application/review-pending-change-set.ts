import type { PendingChangeSet } from '../domain/pending-change-set.js';
import type { FlagState } from '../domain/snapshot-diff.js';
import { readContents, viewSnapshotVersion, type BrowsePorts, type SnapshotVersionView } from './browse-environment.js';
import { detectVersionDrift } from './publish-pending-change-set.js';

export type ReviewPorts = BrowsePorts;

/** The two sides of the draft's diff, each absent when that snapshot is missing or invalid, plus whether the Environment moved on. */
export interface PendingReview {
  readonly baseFlags: readonly FlagState[] | undefined;
  readonly stagedFlags: readonly FlagState[] | undefined;
  readonly drifted: boolean;
}

const baseFlagsOf = (view: SnapshotVersionView): readonly FlagState[] | undefined =>
  view.status === 'available' && view.contents.status === 'valid' ? view.contents.flags : undefined;

export async function reviewPendingChangeSet(
  ports: ReviewPorts,
  environment: string,
  pending: PendingChangeSet,
): Promise<PendingReview> {
  const [base, drifted] = await Promise.all([
    viewSnapshotVersion(ports, environment, pending.baseVersion),
    detectVersionDrift(ports, environment, pending),
  ]);
  const staged = readContents(JSON.stringify(pending.snapshot));
  return {
    baseFlags: baseFlagsOf(base),
    stagedFlags: staged.status === 'valid' ? staged.flags : undefined,
    drifted,
  };
}
