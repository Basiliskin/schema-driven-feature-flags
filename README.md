# FeatureSync

Local-first, schema-driven feature flags and typed configuration for TypeScript.

Flags are defined with Zod schemas, published as immutable versioned snapshots, and evaluated
entirely in memory — no network call per flag check. Everything runs in your own AWS account.

## Packages

| Package | Purpose |
|---|---|
| `@featuresync/core` | Domain model, rule evaluation and the in-memory flag client |

## Deploying to AWS

A CloudFormation template creates the snapshot bucket, change topic, a notification queue with a
dead-letter queue per reading app, and least-privilege publisher and reader policies. Deploy one
full stack for the shared bucket and topic, then one queue-only stack per additional reading app.
See [docs/deploy.md](docs/deploy.md).

## Reproducible CI with a pinned snapshot

`featuresync pull` downloads one published snapshot version, validates it, and writes it
atomically. It never reads the current pointer, so every run loads the same bytes:

```sh
featuresync pull --env production --version 42 --out ./featuresync.json
export FEATURESYNC_FILE=./featuresync.json
```

The bucket comes from `--bucket <bucket>` or `FEATURESYNC_BUCKET`. `pull` exits 0 on success,
1 if the snapshot is invalid, and 3 for usage, access, missing-version or I/O errors. It needs only
`s3:GetObject` on `<env>/snapshots/*` (see [docs/spec/s3-layout.md](docs/spec/s3-layout.md#read-access)).

## Local dashboard

`featuresync-dashboard` serves a small web page on your own machine for browsing an environment's
flags and snapshot versions, publishing a pasted snapshot, and rolling back. It writes through the
same publisher as the CLI, with your own AWS credentials:

```sh
featuresync-dashboard --bucket my-flags --port 4455
# FeatureSync dashboard for bucket my-flags at http://127.0.0.1:4455
```

The bucket comes from `--bucket <bucket>` or `FEATURESYNC_BUCKET`, and `--topic-arn <arn>` or
`FEATURESYNC_TOPIC_ARN` sends a change notification after each write. It listens only on
127.0.0.1 and accepts changes only from its own pages. After a rollback, newer versions stay in the
bucket and block the next publish until you remove them by hand; the environment page explains how.

## Development

Requires Node 22 (see `.nvmrc`) and pnpm.

```sh
pnpm install
pnpm verify   # typecheck, lint, tests with 100% coverage
```

CI runs the same `pnpm verify`.

## License

Apache-2.0
