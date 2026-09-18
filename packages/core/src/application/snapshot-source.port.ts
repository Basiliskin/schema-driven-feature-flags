/** Stops delivering change notifications from a {@link SnapshotSource}. */
export type Unsubscribe = () => void;

/**
 * Where the flag client gets snapshots from: a local file, S3, a test fixture.
 * Values are raw and untrusted; the client validates every one before using it.
 */
export interface SnapshotSource {
  /** Fetches the current raw snapshot. */
  load(): Promise<unknown>;
  /** Push-based sources call `onChange` with each newly published raw snapshot. */
  subscribe?(onChange: (snapshot: unknown) => void): Unsubscribe;
}
