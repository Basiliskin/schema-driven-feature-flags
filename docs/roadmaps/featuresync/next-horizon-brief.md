# Planning Brief — Horizon 2 (AWS snapshot distribution)

**Recommended scope:** `@featuresync/aws` package implementing the SnapshotSource port: S3 reader for `<env>/current.json` → `<env>/snapshots/<n>.json`, change notifications (SNS→SQS or polling), periodic reconciliation (5–15 min), startup/failure modes from docs §22. Integration tests run against docker/docker-compose.yml LocalStack configured only by env vars through AWS SDK v3 clients; the same tests must be runnable against real AWS by changing env.

**Unknowns**
- SNS delivery to app instances without public HTTP: per-instance SQS queue, or treat SNS as optional and rely on polling?
- current.json pointer vs. listing snapshots: consistency and caching (ETag / If-None-Match).

**Research**
- AWS SDK v3 `AWS_ENDPOINT_URL` / service-specific endpoint env support and `forcePathStyle` for S3 on LocalStack (set via env/config, not code branch).
- testcontainers vs. compose-managed LocalStack in CI (auth token as CI secret).

**Decisions needed**
- Publisher write ownership (see blockers.md).
- Whether @featuresync/aws depends on @aws-sdk clients as peer deps.

**Artifacts to inspect:** packages/core SnapshotSource port and Logger port as built in horizon 1; docker/docker-compose.yml.
