# Next horizon brief — horizon 18 (after horizon 17: dashboard segment upload + rollout editing)

## Recommended scope
First, prove horizon 17's segment upload and rollout editing end to end: a LocalStack integration test plus a Playwright spec that uploads a CSV through the browser, edits a rule's rollout, and confirms that the S3 objects (and ideally an SDK S3 source) pick up both. That closes the coverage gap left by the FileReader code in app.js. Then, if a cheap metadata answer is settled first, add a read-only Segment list page built from referencedSegmentKeys and a public pointer reader, preferably with optional count/createdAt written into the pointer at publish time rather than fetching large version objects. Keep structured inSegment editing, per-SDK telemetry, listing via ListObjects, deleting segments and viewing members out of scope.

## Unknowns
- Whether operators actually need a Segment list with member count/createdAt, or whether keys from referencedSegmentKeys plus the pointer version are enough.
- Whether a 100k-member upload (about 25 MiB of CSV) through the 32 MiB urlencoded route and FileReader works within node:http memory and latency limits in practice; nobody has measured it.
- Whether the horizon-16 concurrent-replay 200+422 race also shows up in the new setRollout/removeRollout edits under real concurrent use.
- Whether the FileReader upload code in views/scripts/app.js works in real browsers; nothing tests it end to end yet.

## Research
- Read the horizon-17 roadmap outcome and discoveries.md to confirm which kept phases shipped and which new decisions were recorded (CAS semantics, the body cap).
- Read s3-segment-publisher.ts and segment-pointer.ts to decide whether count/createdAt can go into the pointer at publish time without breaking SDK S3 source parsing.
- Read dashboard.localstack.test.ts and e2e/support/fixtures.ts to see how LocalStack and Playwright already seed buckets, then reuse that for segment and rollout scenarios.
- Check how the SDK S3 snapshot source (horizon 15) loads segments, so an e2e test can prove an SDK picks up both an uploaded segment and a rollout edit.

## Decisions needed
- How to get Segment count/createdAt: extend the pointer contract (additive, optional fields), fetch the version objects, or show the pointer version only.
- Whether to add a public segment pointer reader export to @featuresync/aws, and how it relates to the publisher's private readPointer.
- Whether structured inSegment condition editing (a segment picker) is worth adding over the existing raw 'Edit rules' JSON textarea.
- Whether the e2e proof includes an SDK process reading from LocalStack, or stops at checking the S3 objects the dashboard wrote.

## Artifacts to inspect
packages/aws/src/infrastructure/s3-segment-publisher.ts; packages/aws/src/domain/segment-pointer.ts; packages/aws/src/index.ts; packages/core/src/domain/snapshot.ts (referencedSegmentKeys); packages/dashboard/src/infrastructure/http-server.ts; packages/dashboard/src/infrastructure/aws-adapters.ts; packages/dashboard/src/infrastructure/views/scripts/app.js; packages/dashboard/integration/dashboard.localstack.test.ts; packages/dashboard/e2e/support/fixtures.ts; packages/dashboard/src/domain/flag-edit.ts
