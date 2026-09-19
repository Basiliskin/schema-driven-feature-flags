# S3 layout

This is the contract between whatever publishes snapshots to S3 and every SDK that reads them. The
reader in `@featuresync/aws` implements it; a future publisher must write exactly this layout.

## Key scheme

One bucket can hold many environments. An **environment** is a key prefix (`production`, `staging`,
`dev-alice`): a non-empty string with no `/`.

| Key | Content | Mutability |
|---|---|---|
| `<env>/snapshots/<n>.json` | One snapshot, as defined by [evaluation-semantics.md](evaluation-semantics.md) | Immutable. Written once, never overwritten or deleted while any pointer may name it. |
| `<env>/current.json` | The current pointer (below) | Mutable. Replacing it is how a new version goes live. |
| `<env>/segments/<key>/<n>.json` | One segment version ([Segments](#segments)) | Immutable, like a snapshot. |
| `<env>/segments/<key>/current.json` | The segment's current pointer | Mutable. Replacing it is how a new segment upload goes live. |

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

## Segments

A segment is a population, usually uploaded from a CSV file, that snapshots refer to by key
(evaluation rules in [evaluation-semantics.md](evaluation-semantics.md#segments)). Each segment is
versioned on its own, next to the environment's snapshots:

```text
production/
    current.json
    snapshots/
        43.json
    segments/
        beta-testers/
            current.json
            1.json
            2.json
```

A segment key is 1 to 64 characters from `A-Z`, `a-z`, `0-9`, `-` and `_`, starting with a letter or
digit. Segment versions follow the snapshot version rules, and uploading one is the same two steps
with the same conditional writes as [publishing](#publishing--write-access): write
`segments/<key>/<n>.json` with `IfNoneMatch: '*'`, then replace `segments/<key>/current.json`.

A snapshot names a segment by key only, never by version. SDKs always use the version the segment's
own pointer names, so a new upload takes effect without republishing any flag, and a segment
rollback is a pointer that names a lower version.

### Segment file

The CSV is converted to JSON before upload; SDKs never parse CSV.

```json
{
  "schemaVersion": 1,
  "key": "beta-testers",
  "version": 2,
  "memberAttribute": "userId",
  "members": ["user-42", "user-77", "12345"]
}
```

| Field | Rule |
|---|---|
| `schemaVersion` | The segment format version. Currently `1`. |
| `key` | Must equal the `<key>` in the object's S3 key. |
| `version` | Positive integer; must equal the `<n>` in the object's S3 key. |
| `memberAttribute` | Non-empty string: the CSV column the members came from. Informational only: membership is checked against the attribute named in the `inSegment` condition. |
| `members` | Array of unique strings, each 1 to 256 characters, at most **100000** entries. Numeric identifiers are stored in their [canonical string](evaluation-semantics.md#canonical-string) form (`12345`, not `12345.0`). |

A segment file that breaks any rule, including one with more than 100000 members, is invalid; an
SDK handles it as described in [evaluation-semantics.md](evaluation-semantics.md#segments). Unknown
extra fields are ignored.

**Members are personal data.** SDKs, the CLI and the dashboard never log, print or put into an
error message a member value or a whole segment file. They may report the segment key, version and
member count.

### Segment pointer

```json
{
  "schemaVersion": 1,
  "environment": "production",
  "segmentKey": "beta-testers",
  "version": 2,
  "objectKey": "production/segments/beta-testers/2.json"
}
```

`objectKey` must equal `<environment>/segments/<segmentKey>/<version>.json`. As with the snapshot
pointer, the reader derives the key itself, rejects a pointer that disagrees, and ignores unknown
extra fields.

### Loading and change detection

An SDK loads the segments that the active snapshot references and no others.

- **New snapshot.** Before a new snapshot goes live, the SDK loads every segment it references that
  it does not already hold, then switches snapshot and segments together, so no evaluation sees a
  mix. A referenced segment that cannot be loaded does not hold the switch back: the snapshot goes
  live and that segment's conditions do not match until it loads.
- **Segment updates.** On every Poll Tick, including one where the snapshot pointer answers `304`,
  the SDK then checks each referenced Segment Pointer (`segments/<key>/current.json`) the way it
  checks the snapshot pointer ([Change detection](#change-detection)): a GET with `IfNoneMatch` set
  to the ETag it last saw, where `304` means no change. Full reconciliation ticks send no
  `IfNoneMatch`. A Segment Version is fetched only when the Segment Pointer names a different
  version from the one held; the same version is not fetched again. A new Segment Version replaces
  the old one in the same atomic way.
- **One delivery per Poll Tick.** All Segment Pointer checks of a tick finish before anything is
  delivered. When the snapshot, a Segment Version, or both changed, the S3 source delivers exactly
  one Snapshot Bundle (the snapshot together with its loaded Segment Versions); when nothing
  changed it delivers nothing. A snapshot that references no segments is delivered on its own, as
  before.
- **Unloadable segments.** A segment whose Segment Pointer or Segment Version is missing,
  unreadable, invalid, or names another environment or key is logged by segment key only, never
  with the underlying error, since that could contain member values. If the S3 source already
  holds a Segment Version for that key, it keeps it in the Snapshot Bundle as the last-known-good
  copy; otherwise the segment is left out of the bundle and Fail-safe No-match applies: its
  conditions do not match. The failed segment is read again on every Poll Tick until it loads.
- **Unreferenced segments.** When a new snapshot no longer references a segment, the S3 source
  drops its Segment Version and stops checking its Segment Pointer.
- **No notification.** A segment upload sends no [change notification](change-notification.md);
  segment changes are picked up by polling only.

Segment objects sit under the `<env>/` prefix, so the existing Reader and Publisher policies already
cover them; no IAM change is needed.

## Rollback

A rollback is a pointer that names a lower version than before. Nothing else changes: the older
snapshot is still in `snapshots/`. The reader always follows whatever version the pointer names and
never refuses a version because it is lower than the one it already holds.

## Read access

The deployment stack ([`packages/deploy/template/featuresync-stack.json`](../../packages/deploy/template/featuresync-stack.json))
is the source of truth for FeatureSync's IAM policies. A reading app attaches its **Reader Policy**
(output `ReaderPolicyArn`), which grants:

| Action | Resource |
|---|---|
| `s3:GetObject` | `arn:aws:s3:::<bucket>/<env>/*` |
| `sqs:ReceiveMessage`, `sqs:DeleteMessage` | the app's notification queue (not its dead-letter queue) |
| `s3:ListBucket`, only when the stack parameter `ReaderListBucket` is `true` | `arn:aws:s3:::<bucket>`, condition `StringLikeIfExists` `s3:prefix` = `<env>/*` |

Without `s3:ListBucket`, S3 answers a request for a missing key with `403 AccessDenied`, not
`404 NoSuchKey`. The reader therefore treats both as "not found", while keeping the original error
as the cause so a genuine permission problem stays visible in logs.

`featuresync pull` reads one immutable snapshot and never `current.json`, so a CI principal that
only pulls pinned versions attaches the Reader Policy too. Without `s3:ListBucket` a missing version
answers `403`, and `pull` reports it as access denied rather than as a missing version. Deploy the
stack with `ReaderListBucket=true` if CI should tell the two apart. The condition uses
`StringLikeIfExists` because a `GetObject` request carries no `s3:prefix` key: a plain `StringLike`
would never match it, and S3 would keep answering `403`.

## Publishing / write access

A publisher attaches the stack's **Publisher Policy** (output `PublisherPolicyArn`): `s3:GetObject`
and `s3:PutObject` on `arn:aws:s3:::<bucket>/<env>/*`, `s3:ListBucket` on the bucket with the same
`StringLikeIfExists` `s3:prefix` = `<env>/*` condition, and `sns:Publish` on the change topic. The
publisher only treats `404` as "not found", so it needs `s3:ListBucket` to read a missing
`current.json` on the first publish. It never deletes or overwrites a snapshot, and every write is
conditional:

1. Read `current.json` and keep its ETag (none on the first publish).
2. Write `snapshots/<n>.json` with `IfNoneMatch: '*'`, so an existing version is never replaced.
3. Write `current.json` with `IfMatch: <etag>`, or `IfNoneMatch: '*'` on the first publish, so a
   pointer moved by someone else in the meantime is never clobbered.

A lost condition comes back as `412` with error name `PreconditionFailed`, for both `IfNoneMatch`
and a stale `IfMatch`; the LocalStack integration suite asserts exactly this shape. Real S3 may also
answer `409 ConditionalRequestConflict` while a competing write is in flight, and the publisher
treats it the same way: `VERSION_EXISTS` on the snapshot write, `CONFLICT` on the pointer write.

If the snapshot write succeeds but the pointer write fails, `snapshots/<n>.json` is left orphaned:
readers never see it, but the next publish computes the same `<n>` and fails with
`VERSION_EXISTS`. Recover by hand — delete the orphaned snapshot, or point `current.json` at it —
and publish again.

## Change detection

A reader follows changes by polling `<env>/current.json`; it never lists the bucket.

- **Conditional GET.** Each poll sends `GetObject` with `IfNoneMatch` set to the pointer ETag it last
  saw. The first poll, before any ETag is known, sends no condition.
- **304 means no change.** With `@aws-sdk/client-s3` the `304 Not Modified` answer does not come back
  as a response: `send()` rejects with a service error whose `$metadata.httpStatusCode` is `304`
  (there is no `NotModified` exception class). The reader treats that rejection as "unchanged" and
  every other rejection as a failure it logs while keeping the active snapshot. LocalStack answers
  the same way; the integration suite asserts it.
- **Version dedup.** A changed pointer is delivered only when its `version` differs from the one
  already loaded. A pointer rewritten with the same version (new ETag, same content) only updates the
  stored ETag. Snapshots are immutable per version, so the version is the identity.
- **Reconciliation.** Every `reconcileIntervalMs` (default 10 minutes, never below the poll
  interval) one poll omits `IfNoneMatch` and reads the pointer in full, so a change an ETag
  comparison missed still arrives. Version dedup applies to it as to any other poll.

### Local S3 endpoint

The reader builds its client from the standard AWS SDK environment only; there is no LocalStack
code path. The integration suite runs with:

| Variable | Value |
|---|---|
| `AWS_ENDPOINT_URL_S3` | `http://s3.localhost.localstack.cloud:4566` |
| `AWS_REGION` | `us-east-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` |

The JavaScript SDK has no environment variable for path-style addressing. None is needed: the SDK
keeps its default virtual-hosted addressing (`<bucket>.s3.localhost.localstack.cloud`), and every
subdomain of `localhost.localstack.cloud` resolves to `127.0.0.1`.

## Failure modes

A reader only fetches and reports; the flag client decides what a failure means. Its behaviour is
already defined by `@featuresync/core`:

- **S3 unreachable, pointer or snapshot missing, invalid pointer** — the source rejects `load()` with
  a typed error. At startup with no snapshot the client throws `StartupError`; after startup it
  keeps serving the last good snapshot.
- **Snapshot fails validation** — core rejects it, logs the error and keeps the last good snapshot.
  The reader never validates snapshot content itself.
