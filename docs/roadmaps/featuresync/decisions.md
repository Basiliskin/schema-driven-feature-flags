# Decisions
- 2026-09-18 | horizon 1 | The snapshot is language-neutral JSON with a schemaVersion field — because future non-TS SDKs must consume the same contract.
- 2026-09-18 | horizon 1 | LocalStack is reached only via standard AWS SDK env config (AWS_ENDPOINT_URL etc.), never a code branch — because prod and local must run identical code.
- 2026-09-18 | horizon 1 | CI enforces 100% line/branch/function/statement coverage and ESLint layer-boundary rules — because the project must be production-grade and fully covered.
- 2026-09-18 | horizon 1 | Flag queries are synchronous in-memory lookups; loading lives behind a SnapshotSource port — because local-first evaluation is the core promise.
