# Next horizon brief — horizon 19 (after horizon 18: LocalStack proof + Segment List Page)

## Recommended scope
Horizon 19 should be a single-theme infrastructure horizon: land the browser proof and the CI that runs it as one indivisible unit, and little else. That is roughly three to four phases — a new LocalStack-backed Playwright fixture that stands up a per-test bucket and exposes an S3 client for assertions (a new support module, not an extension of the in-memory fixture); the env/config plumbing that lets playwright.config.ts see AWS settings; one browser spec covering the CSV FileReader upload and a rollout edit against a schemaVersion 2 seed; and the CI job (browser install, AWS env, run script) without which the spec is laptop-only. Budget explicit slack for the risk that a real browser surfaces genuine bugs in the never-executed app.js upload path, turning a proof horizon into a fix horizon. Treat the shared seed-snapshot fixture extraction as an optional in-scope cleanup only if it falls out naturally. Keep out everything the user has already capped or deferred: no SDK/flag-client read-back, no member count or createdAt, no 100k-member load measurement, no schemaVersion 1 auto-upgrade decision, no orphaned-object cleanup, no segment picker. If the horizon looks like it will finish early, the rollout-form DRY cleanup is the cheapest honest addition.

## Unknowns
- Where should the browser+LocalStack proof actually run in CI — extended inside the existing `localstack` job (which already has LocalStack up and AWS env), or as a third job that must stand its own LocalStack up?
- How does the Playwright process get AWS credentials/endpoint today? vitest.integration.config.ts loads ../../.env manually and playwright.config.ts has no equivalent — is .env loading the right mechanism, or should CI supply AWS_* env directly?
- Which browser will CI use — the bundled Chromium (PLAYWRIGHT_CHANNEL='') with an install step, or the locally installed Chrome channel the config defaults to on a developer machine?
- What happens to `pnpm test:e2e` when LOCALSTACK_AUTH_TOKEN is absent: fail (the horizon-3 decision for integration) or skip?
- Did a real browser ever exercise the FileReader path in views/scripts/app.js? Horizon 18 deferred the browser spec, so that path is still completely unexercised in a browser.
- Is app.js formally accepted as outside the 100% coverage gate (it is a .js file outside coverage include ['packages/*/src/**/*.ts']), or does someone still expect a jsdom harness?
- Can a Playwright spec that edits a rollout collide with the unresolved horizon-16/17 concurrent-replay 200+422 race, and is that a CI flakiness risk?
- Does the schemaVersion 2 seed snapshot introduced in horizon 18 live somewhere reusable, or is it a file-local literal the browser spec would have to duplicate?

## Research
- Re-read packages/dashboard/playwright.config.ts — confirm whether testDir, projects, env or .env loading changed; discovery found none of it present.
- Read .github/workflows/ci.yml and confirm it still has exactly the `verify` and `localstack` jobs, and inspect how the localstack job pins the image, waits, and exports AWS_*/LOCALSTACK_AUTH_TOKEN — that job is the template for the new browser job.
- Read packages/dashboard/e2e/support/fixtures.ts so the new LocalStack fixture mirrors its startDashboardServer/port-0 shape rather than being bolted onto InMemoryEnvironment (whose publishSegment throws).
- Read the schemaVersion 2 seed snapshot literal inside packages/dashboard/integration/dashboard-segments.localstack.test.ts and decide whether the browser spec reuses or duplicates it — this is the trigger for the deferred shared-fixture extraction.
- Read app.js's [data-segment-upload] handler and views/segment-page.ts's form; confirm the data-segment-upload / data-segment-file selectors still exist unchanged before writing browser selectors against them.
- Check the root package.json scripts: discovery found no root e2e script; confirm whether one now exists and what `pnpm test:integration` does.
- Re-read packages/dashboard/src/main.ts / createAwsDashboardPorts to confirm the fixture can start the dashboard against a per-test bucket purely from AWS SDK env.
- Check Playwright's trace/screenshot/video retention settings, because a failing upload spec could capture CSV member content.

## Decisions needed
- Whether the browser suite runs in the existing `localstack` CI job or a new dedicated job.
- Where AWS/LocalStack configuration for Playwright lives: .env loading inside playwright.config.ts vs. CI-supplied env only vs. both.
- Whether the browser suite is required (fails CI, per the horizon-3 no-skip precedent) or advisory while it stabilizes.
- Whether to extract the schemaVersion 2 seed snapshot into a shared fixture module now that the browser spec makes it a second consumer.
- Whether app.js is formally exempted from the 100% coverage gate with the Playwright spec as its only proof, or whether a jsdom harness is added.
- How the browser spec asserts on S3: a dedicated S3 client exposed by the fixture vs. asserting only through dashboard HTTP/UI — and whether assertions key off the Segment Pointer rather than object existence.
- Whether the browser scope stays capped at CSV upload + rollout edit, or expands to cover the Segment List Page navigation added in horizon 18.
- Whether to spend part of the horizon on the deferred rollout-form.ts DRY cleanup, now that browse-environment exposes segmentKeys.

## Artifacts to inspect
packages/dashboard/playwright.config.ts; packages/dashboard/e2e/support/fixtures.ts; packages/dashboard/integration/dashboard-segments.localstack.test.ts; packages/dashboard/integration/dashboard.localstack.test.ts; .github/workflows/ci.yml; packages/dashboard/src/main.ts; packages/dashboard/src/infrastructure/views/scripts/app.js; packages/dashboard/src/infrastructure/views/segment-page.ts; packages/dashboard/src/infrastructure/segment-routes.ts; packages/aws/src/infrastructure/s3-segment-version-reader.ts; packages/aws/integration/s3-segment-publisher.localstack.test.ts; vitest.config.ts; vitest.integration.config.ts; package.json (root scripts); packages/dashboard/src/infrastructure/views/rollout-form.ts
