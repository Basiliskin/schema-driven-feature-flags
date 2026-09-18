/** Why an S3 snapshot could not be turned into a raw snapshot. */
export type S3SnapshotErrorReason =
  'POINTER_NOT_FOUND' | 'SNAPSHOT_NOT_FOUND' | 'INVALID_POINTER' | 'INVALID_JSON' | 'REQUEST_FAILED';

/** An S3 object needed to load a snapshot was missing, unreadable or malformed. `cause` holds the underlying error. */
export class S3SnapshotError extends Error {
  override readonly name = 'S3SnapshotError';

  constructor(
    readonly reason: S3SnapshotErrorReason,
    readonly key: string,
    cause: unknown,
  ) {
    super(`${reason} for s3 object ${key}`, { cause });
  }
}
