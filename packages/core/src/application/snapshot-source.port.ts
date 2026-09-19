/** Stops delivering change notifications from a {@link SnapshotSource}. */
export type Unsubscribe = () => void;

/**
 * A snapshot delivered together with the segments it references. `segments` holds raw segment
 * files; each is validated on its own, and one that is invalid or absent counts as missing.
 */
export interface SnapshotBundle {
  readonly snapshot: unknown;
  readonly segments: readonly unknown[];
}

/**
 * Where the flag client gets snapshots from: a local file, S3, a test fixture.
 * Each payload is a bare raw snapshot or a {@link SnapshotBundle}. Values are raw and untrusted;
 * the client validates every one before using it.
 */
export interface SnapshotSource {
  /** Fetches the current raw snapshot or bundle. */
  load(): Promise<unknown>;
  /** Push-based sources call `onChange` with each newly published raw snapshot or bundle. */
  subscribe?(onChange: (snapshot: unknown) => void): Unsubscribe;
}
