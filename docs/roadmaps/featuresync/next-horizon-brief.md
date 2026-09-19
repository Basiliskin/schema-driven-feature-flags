# Next-horizon brief — for horizon 11 (prepared by horizon 10 planning, 2026-09-19)

## Unknowns
- Is pasted/uploaded JSON enough, or do operators need in-browser flag editing? Nobody has checked with users since horizon 10.
- Does the single Origin/Host check on POSTs hold up in browser edge cases: a missing Origin header, DNS rebinding against the 127.0.0.1 bind, or a proxied localhost?
- How often do operators hit VERSION_EXISTS after a rollback or an orphaned snapshot? That would show whether the horizon-4 decision needs revisiting.
- Is pointer-range browsing (1..current, gaps shown as not available) usable at many versions, or is pagination needed?
- Can hand-written HTML strings keep 100% branch coverage as the UI grows?

## Research
- Read packages/dashboard as built: server bootstrap, routing, the Origin/Host guard, the error map and the views. Measure how much each new view costs in tests.
- Check how the dashboard covers the 7 S3PublishError reasons, the 6 S3FetchError reasons and the onNotifyError warning.
- Compare the dashboard's config and error helpers with packages/cli/src/main.ts to see how much duplication built up.
- Read the horizon-4 decisions and docs/spec/s3-layout.md for what a publish-after-rollback fix would need to change.
- Check what adding ListObjectsV2 to the horizon-9 IAM publisher policy would require.
- Check what core exposes for evaluation, to judge whether a diff or preview can be built without changing core.

## Decisions needed
- Which deferred feature comes next: in-browser editing, diff or evaluation preview, file upload, or UI polish.
- Whether to reopen the horizon-4 decision (publish after rollback), or keep documenting the limitation.
- Whether versions above the current pointer should become visible (ListObjectsV2 plus an IAM change).
- Whether to extract the config and error helpers shared by the CLI and the dashboard, or keep the duplication.
- Whether to stay with plain node:http and HTML strings, or adopt a UI framework or build step.
- Whether write protection needs more than the Origin/Host check before richer write features are added.
- Whether the dashboard should get live updates via SNS/SQS, or keep manual refresh.

## Artifacts to inspect
packages/dashboard/, packages/aws/src/infrastructure/s3-snapshot-publisher.ts, packages/aws/src/infrastructure/s3-snapshot-fetcher.ts, packages/aws/src/index.ts, packages/aws/src/domain/current-pointer.ts, packages/core/src/index.ts, packages/cli/src/main.ts, docs/spec/s3-layout.md, decisions.md, package.json, vitest.config.ts, eslint.config.js, .github/workflows/ci.yml

## Recommended next-horizon scope
Build a second dashboard slice, one theme wide. The most natural theme is safer publishing: snapshot file upload beside pasted JSON, and a read-only diff between a version and the current pointer (plus an evaluation preview if it's cheap using existing core APIs). Hold off on in-browser editing. The publish-after-rollback fix and ListObjectsV2 visibility come into scope only if the horizon-4 decision and the horizon-9 IAM policy are explicitly reopened. Stay framework-free unless diffing forces a change, and keep 100% coverage.
