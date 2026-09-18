# Blockers
- 2026-09-18 | horizon 1 | IAM least-privilege cannot be verified on LocalStack Community (no IAM enforcement) — need real-AWS test account or policy-assertion tests?
- 2026-09-18 | horizon 1 | Publisher trigger: docs describe both "UI writes S3 → Lambda validates" and "Lambda writes snapshot" — which component owns the write?
- 2026-09-18 | horizon 1 | How does an app subscribe to SNS without a public endpoint (SQS queue per instance vs polling current.json)?
- 2026-09-18 | horizon 2 | Does SDK v3 GetObject+IfNoneMatch surface 304 as a thrown NotModified, as $metadata.httpStatusCode 304, or both — and does LocalStack match real S3?
- 2026-09-18 | horizon 2 | Can LocalStack path-style addressing be set purely via env/shared config, or is the localhost.localstack.cloud host needed?
- 2026-09-18 | horizon 2 | Is a LOCALSTACK_AUTH_TOKEN GitHub secret available, and how should CI behave on fork PRs without it? — resolved by decision 2026-09-18
- 2026-09-18 | horizon 2 | Does mapping 403 AccessDenied to *_NOT_FOUND hide real permission/credential errors?
- 2026-09-18 | horizon 2 | Should the current pointer keep both version and snapshotKey, or drop the redundant snapshotKey? — resolved by decision 2026-09-18
- 2026-09-18 | horizon 2 | Can packages/aws typecheck/lint/test without building core first (core exports dist only)? — resolved
