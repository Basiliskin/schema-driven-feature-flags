# S3 layout

This is the contract between whatever publishes snapshots to S3 and every SDK that reads them. The
reader in `@featuresync/aws` implements it; a future publisher must write exactly this layout.

## Key scheme

One bucket can hold many environments. An **environment** is a key prefix (`production`, `staging`,
`dev-alice`): a non-empty string with no `/`.

| Key | Content | Mutability |
|---|---|---|
| `<env>/snapshots/<n>.json` | One snapshot, as defined by [evaluation-semantics.md](evaluation-semantics.md) | Immutable. Written once, never overwritten or deleted while any pointer may name it. |
| `<env>/current.json` | The current pointer (below) | The only mutable key. Replacing it is how a new version goes live. |

`<n>` is the snapshot version: a positive integer (`1`, `2`, `43`) written in decimal with no
leading zeros, sign or padding.

```text
production/
    current.json
    snapshots/
        41.json
        42.json
        43.json
```

Publishing is two steps: write the new `snapshots/<n>.json`, then replace `current.json`. A reader
therefore never sees a pointer to a snapshot that does not exist yet. S3 replaces an object
atomically, so a reader sees either the old pointer or the new one, never a mix.

## Current pointer

```json
{
  "schemaVersion": 1,
  "environment": "production",
  "version": 43,
  "snapshotKey": "production/snapshots/43.json"
}
```

| Field | Rule |
|---|---|
| `schemaVersion` | The pointer format version. Currently `1`. |
| `environment` | Must equal the environment the reader was configured with. |
| `version` | Positive integer: the snapshot version that is live. |
| `snapshotKey` | Must equal `<environment>/snapshots/<version>.json`. |

The reader derives the snapshot key from `environment` and `version` itself and rejects a pointer
whose `snapshotKey` disagrees. It never fetches an arbitrary key taken from the pointer, so a
malformed or tampered pointer cannot redirect it outside the environment's `snapshots/` prefix.
Unknown extra fields are ignored.

Invalid, because `snapshotKey` does not match `version`:

```json
{
  "schemaVersion": 1,
  "environment": "production",
  "version": 43,
  "snapshotKey": "production/snapshots/42.json"
}
```

A pointer is also invalid when a field is missing, `version` is not a positive integer, or the
content is not JSON.

## Rollback

A rollback is a pointer that names a lower version than before. Nothing else changes: the older
snapshot is still in `snapshots/`. The reader always follows whatever version the pointer names and
never refuses a version because it is lower than the one it already holds.

## Read access

Applications need only `s3:GetObject`, scoped to the bucket's keys:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<bucket>/*"
    }
  ]
}
```

Without `s3:ListBucket`, S3 answers a request for a missing key with `403 AccessDenied`, not
`404 NoSuchKey`. The reader therefore treats both as "not found", while keeping the original error
as the cause so a genuine permission problem stays visible in logs.

## Failure modes

A reader only fetches and reports; the flag client decides what a failure means. Its behaviour is
already defined by `@featuresync/core`:

- **S3 unreachable, pointer or snapshot missing, invalid pointer** — the source rejects `load()` with
  a typed error. At startup with no snapshot the client throws `StartupError`; after startup it
  keeps serving the last good snapshot.
- **Snapshot fails validation** — core rejects it, logs the error and keeps the last good snapshot.
  The reader never validates snapshot content itself.
