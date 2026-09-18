# Decisions
- 2026-09-18 | horizon 1 | The snapshot is language-neutral JSON with a schemaVersion field — because future non-TS SDKs must consume the same contract.
- 2026-09-18 | horizon 1 | LocalStack is reached only via standard AWS SDK env config (AWS_ENDPOINT_URL etc.), never a code branch — because prod and local must run identical code.
- 2026-09-18 | horizon 1 | CI enforces 100% line/branch/function/statement coverage and ESLint layer-boundary rules — because the project must be production-grade and fully covered.
- 2026-09-18 | horizon 1 | Flag queries are synchronous in-memory lookups; loading lives behind a SnapshotSource port — because local-first evaluation is the core promise.
- 2026-09-18 | horizon 2 | Horizon 2 is read-only: no snapshot publisher is built; the reader defines the S3 layout contract a future publisher must follow — because the user scoped publishing out.
- 2026-09-18 | horizon 2 | Apps detect snapshot changes by polling current.json (ETag) plus reconciliation first; SNS→SQS push comes in a later horizon — because the user chose polling first.
- 2026-09-18 | horizon 2 | @aws-sdk/client-s3 is a peer (and dev) dependency of @featuresync/aws, never a direct dependency — because consumers must control their single SDK copy.
- 2026-09-18 | horizon 2 | @featuresync/aws never validates Snapshots itself; it hands raw JSON to core, which validates every value — because parseSnapshot stays private to core.
