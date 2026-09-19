# Next horizon brief — horizon 15 (after horizon 14: segment CSV upload + S3 publisher)

## Recommended scope
Make segment loading in createS3SnapshotSource (load-segments-in-s3-source) the core of the next horizon. Follow it with an end-to-end LocalStack chain test: CSV upload, then publish, then a source bundle, then a FlagClient inSegment/rollout check, then a re-upload that changes the evaluation. If there is room, add a bounded MAX_SEGMENT_MEMBERS load measurement to close the horizon-13 blocker. Leave out dashboard segment UI, segment rollback/delete, the file-source watch fix and shared publisher extraction.

## Unknowns
- Does a 100,000-member Segment Version fit the Node SDK's memory and poll-latency budget when N segments reload in one tick?
- How should a poll tick be ordered when the snapshot pointer and several segment pointers move together, so one bundle is emitted rather than several stale ones?
- Does LocalStack handle many concurrent IfNoneMatch pointer GETs like real S3, or must tests run them serially?
- Should a push-triggered snapshot re-read also re-check segment pointers?
- After a segment fails to load, is it retried every tick or only when its pointer ETag changes?

## Research
- Read s3-snapshot-source.ts's serial queue, ETag/version dedupe and onChange flow before placing segment polling in it.
- Confirm how FlagClient treats an omitted segment (keeps the held one) against the fail-safe decision for newly referenced keys.
- Check that horizon-14 segment-pointer module and core exports landed as planned.
- Re-read s3-layout.md and change-notification.md for drift introduced by horizon 14.
- Review LocalStack source tests asserting bare-snapshot output; they must change to bundle output.

## Decisions needed
- How the S3 source reports segment load failures: logger only, a new onError option, or both.
- Whether segment pointer polls in a tick run in parallel or serially inside the single queue.
- Whether the source emits a bundle only when the snapshot references segments, or always.
- Whether the MAX_SEGMENT_MEMBERS load test is CI-gated or a one-off recorded measurement.

## Artifacts to inspect
packages/aws/src/infrastructure/s3-snapshot-source.ts, s3-read.ts; packages/aws/src/domain/segment-pointer.ts; packages/aws/test/infrastructure/s3-snapshot-source.*.test.ts; packages/aws/integration/s3-snapshot-source.localstack.test.ts; packages/core/src/application/flag-client.ts, snapshot-source.port.ts; packages/core/src/domain/segment-contract.ts; docs/spec/s3-layout.md
