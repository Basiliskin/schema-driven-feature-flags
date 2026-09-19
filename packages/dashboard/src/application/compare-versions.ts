import { diffFlags, type FlagChange } from '../domain/snapshot-diff.js';
import { viewSnapshotVersion, type BrowsePorts, type SnapshotMetadata } from './browse-environment.js';

export type VersionComparison =
  | { readonly status: 'up-to-date'; readonly environment: string; readonly version: number }
  | {
      readonly status: 'changed';
      readonly environment: string;
      readonly from: number;
      readonly to: number;
      /** Who published the latest version; absent when its snapshot can't be read. */
      readonly latest?: SnapshotMetadata;
      /** Absent when either side's snapshot is missing or invalid, so no flag-level diff exists. */
      readonly changes?: readonly FlagChange[];
    };

/** What changed in an Environment since the version a page was rendered from. */
export async function compareWithCurrent(
  ports: BrowsePorts,
  environment: string,
  since: number,
): Promise<VersionComparison> {
  const current = await ports.readCurrentVersion(environment);
  if (current === undefined || current === since) {
    return { status: 'up-to-date', environment, version: current ?? since };
  }
  const [before, after] = await Promise.all([
    viewSnapshotVersion(ports, environment, since),
    viewSnapshotVersion(ports, environment, current),
  ]);
  const valid = (view: typeof before) =>
    view.status === 'available' && view.contents.status === 'valid' ? view.contents : undefined;
  const from = valid(before);
  const to = valid(after);
  return {
    status: 'changed',
    environment,
    from: since,
    to: current,
    ...(to === undefined ? {} : { latest: to.metadata }),
    ...(from === undefined || to === undefined ? {} : { changes: diffFlags(from.flags, to.flags) }),
  };
}
