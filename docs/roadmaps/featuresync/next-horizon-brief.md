# Next horizon brief — horizon 20 (after horizon 19: browser proof + CI browser step)

## Recommended scope
Horizon 20 should be small and corrective rather than additive: pick one of the standing open blockers — most plausibly the concurrent-replay 200+422 race, since it is the one that actively degrades CI trust and shares code with the orphaned-object blocker — and spend the horizon characterizing it precisely, fixing it at one clearly-chosen layer, and landing a deterministic regression test at the integration level. That is roughly four to five phases: a reproduction/characterization phase, a decision-recording phase on where the fix belongs, the fix itself, and regression coverage with the 100% gate intact. It should NOT also grow the browser suite, add a cross-browser matrix, tackle the 100k-member load question, or resolve the schemaVersion-1 auto-upgrade question — each of those is a separate horizon, and bundling any two of them reproduces the overreach this horizon deliberately avoided. If the race turns out not to reproduce through any user-reachable path, the honest outcome is to downgrade it from blocker to documented note and spend the remaining horizon on the orphaned-object cleanup instead, not to expand scope.

## Unknowns
- Does the concurrent-replay 200+422 race actually reproduce through the browser/rollout-edit surface, or only through direct concurrent HTTP replay — i.e. is it a UI-reachable defect or a test-harness artifact?
- What is the real cause of the 200+422 outcome: does the replay path return 200 for an edit that was in fact rejected, or 422 for one that in fact applied? Nobody has characterized which of the two responses is the lying one.
- How long does the localstack CI job now run with the Chromium install plus browser suite added, and does the added time or new failure surface (apt deps, download flake) make retries:0 untenable?
- Did the browser proof actually expose defects in app.js (missing FileReader error listener, double-submit when csv is pre-populated, no size guard against the 32 MiB cap), and were they fixed or accepted?
- Given app.js is permanently outside the coverage include glob, what is the project's standing rule for how much logic may live there before it must move into a covered .ts module?
- Should setRollout on a schemaVersion 1 snapshot auto-upgrade to 2, fail loudly, or stay as today's parse rejection — horizon 19 sidestepped this by seeding v2.
- At what CSV size does the FileReader + urlencoded path actually degrade (memory, latency, the 32 MiB server cap), and is the failure mode a clear error or a silent hang?
- Are orphaned segment version objects from a lost pointer IfMatch race actually accumulating in practice, and does anything (SDK read, segment list page, cost) care?
- Is there any remaining dashboard behaviour that exists only in browser-executed code and has neither integration nor browser coverage?

## Research
- Read the merged horizon-19 browser spec and its LocalStack fixture as landed, plus the actual CI run time and any flakes in the localstack job, before assuming the browser harness is a stable place to add more specs.
- Reproduce the 200+422 race deliberately against the LocalStack integration harness (packages/dashboard/integration/) and record which response is wrong, before planning a fix.
- Trace the edit-feature CAS/replay code path end to end — the retry/replay logic plus the IfMatch pointer write — since both the 200+422 race and the orphaned-segment-object blocker likely originate in the same optimistic-concurrency code.
- Diff app.js against the browser spec's actual assertions to see which of its branches are still unexercised, so the next horizon knows exactly what the accepted coverage exemption is hiding.
- Check whether the shared seed-snapshot fixture module landed somewhere both integration/ and e2e/ import it, and whether a third consumer would fit without another move.
- Look at how much the localstack job's wall-clock grew and whether Chromium install is cached, before adding any further browser work to that job.

## Decisions needed
- Whether horizon 20 is a defect/hardening horizon (fix the 200+422 race and the orphaned-object cleanup) or a feature horizon (more dashboard/segment capability) — these compete for the same concurrency code and cannot both be small.
- Whether the 200+422 race gets fixed at the source (the CAS/replay semantics) or contained (idempotency key / dedupe at the route layer) — a domain-semantics change versus a transport-layer one.
- Whether setRollout auto-upgrades a schemaVersion 1 snapshot, rejects it with an explicit migration error, or requires an explicit separate upgrade operation.
- Whether orphaned segment version objects are cleaned by a compensating delete on the failed-pointer path, by a sweep, or explicitly accepted as harmless garbage with a documented rationale.
- Whether the browser suite stays a single-spec proof pinned to one Chromium in the localstack job, or becomes a growing e2e tier (projects matrix, more specs, its own job) — the first addition after the proof is the point of no return.
- Whether app.js stays permanently exempt from coverage with Playwright as its only evidence, or its logic is progressively moved into covered TypeScript modules so the exemption shrinks toward nothing.
- Whether large-CSV behaviour is addressed by a client-side size guard, a streaming/multipart upload replacing the urlencoded FileReader path, or a documented supported-size limit.

## Artifacts to inspect
packages/dashboard/src/infrastructure/http-server.ts; packages/dashboard/src/infrastructure/views/scripts/app.js; packages/dashboard/src/infrastructure/segment-routes.ts; packages/dashboard/src/infrastructure/views/rollout-form.ts; packages/dashboard/e2e/support/localstack-fixtures.ts; packages/dashboard/e2e/concurrent-edits.spec.ts; packages/dashboard/integration/dashboard-segments.localstack.test.ts; packages/dashboard/playwright.config.ts; .github/workflows/ci.yml; docs/roadmaps/featuresync/discoveries.md
