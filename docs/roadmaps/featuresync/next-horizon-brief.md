# Planning Brief — Horizon 3 (S3 polling, LocalStack suite, CI)

**Recommended scope:** Finish the reader side of AWS snapshot distribution on top of horizon 2's load(): subscribe()-based polling with conditional GETs (IfNoneMatch, 304 = no change), slower reconciliation, timer cleanup on unsubscribe — fake-timer tests at 100% coverage; an opt-in, env-only integration suite against docker-compose LocalStack; a CI job running it on a pinned, health-checked LocalStack. First confirm what horizon 2 did with the pointer shape and AccessDenied mapping, and how SDK v3/LocalStack report 304. Keep publisher, SNS/SQS push, IAM enforcement, bucket provisioning and a real-AWS CI job out of scope unless reopened. Deferred phase candidates are listed in horizon-02 roadmap.md "Out of Scope".

**Unknowns**
- Does SDK v3 GetObject with IfNoneMatch surface 304 as a thrown NotModified error, as $metadata.httpStatusCode 304, or both — and does LocalStack match real S3?
- Can LocalStack path-style addressing be set purely via env/shared config (AWS_ENDPOINT_URL_S3 + force-path-style), or is the localhost.localstack.cloud host needed?
- Is a LOCALSTACK_AUTH_TOKEN GitHub secret available, and how should CI behave on fork PRs without it?
- Does mapping AccessDenied to *_NOT_FOUND hide real permission/credential errors (accepted preview concern)?
- Did horizon 2 keep both version and snapshotKey in the pointer, or simplify it? Polling dedup depends on it.
- Is any real AWS account available to run the integration suite unchanged?
- Can packages/aws typecheck/lint/test without building core first (dist-only exports)?

**Research**
- Read horizon 2 results: packages/aws/src/infrastructure/s3-snapshot-source.ts, s3-snapshot-error.ts, src/domain/current-pointer.ts, docs/spec/s3-layout.md — what closure state (ETag, version) load() leaves for polling.
- Check SDK v3 docs/source for IfNoneMatch 304 reporting, then try it by hand against docker-compose LocalStack.
- Check LocalStack docs on path-style via AWS_ENDPOINT_URL_S3 and localhost.localstack.cloud.
- Check vitest fake timers with async callbacks for non-overlapping ticks at 100% branch coverage without pragmas.
- Read how flag-client.ts calls subscribe/close — no double timers, no leak after close.
- Check docker compose --wait / LocalStack GitHub Action health handling and a pinnable image tag.

**Decisions needed**
- Polling vs reconciliation dedup: re-deliver, dedupe by version, or by content hash?
- pollInterval/reconcileInterval defaults and bounds: enforce 5–15 min reconcile range or advisory?
- Overlapping ticks: skip, queue, or single chained timer?
- Integration test separation: separate vitest config + test:integration script vs tag/project filtering.
- CI behaviour when the LocalStack token is missing: skip visibly or fail.
- Whether a real-AWS CI job is in scope or documented-only.
- Whether to revisit AccessDenied-as-not-found before polling relies on it.

**Artifacts to inspect:** docs/spec/s3-layout.md; packages/aws/src/{domain/current-pointer.ts, infrastructure/s3-snapshot-source.ts}; packages/core/src/application/{snapshot-source.port.ts, flag-client.ts}; packages/core/src/infrastructure/file-snapshot-source.ts; vitest.config.ts; package.json; eslint.config.js; .github/workflows/ci.yml; docker/docker-compose.yml; docs/notes.md.
