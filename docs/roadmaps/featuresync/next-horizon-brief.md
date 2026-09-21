# Next horizon brief — horizon 25 (after horizon 24: version paging and flag URLs)

## Recommended scope
Treat the next horizon as one cohesive URL-state horizon: establish the shared query-string contract (user item 3), build the server-side flag filter and any flag paging on top of it (item 4), and land the sticky Section Nav (item 5) as a small tail phase. That is deliberately more than horizon 24 carried, because items 3 and 4 cannot be separated — item 4's semantics are defined by item 3's contract — but the weight is not in the feature logic, it is in the round-trip: every write form (feature edit, rollout, segment attach, new flag, publish dialog, rollback) has to carry or redirect the state, and the POST handlers currently re-render inline rather than redirecting, so whichever mechanism is chosen touches roughly six view modules plus the three POST handlers in http-server.ts. Budget real phases for the two test surfaces that this work breaks rather than extends: flag-list.spec.ts's live-filter spec must be rewritten against a submit-and-render flow, and the 100% branch/line/function/statement coverage gate over hand-written HTML means every new clamp, echo and open/closed branch needs its test in the same phase it is written. Expect a phase count in the six-to-eight range, and resist folding anything else in — no segment-list filtering or paging, no changes to edit/publish/rollback/replay semantics, no new app.js logic, and no version-index or bucket-listing shortcuts. If the horizon starts to overflow, item 5 is the clean thing to drop: it is markup and CSS only and depends on nothing the other two produce.

## Unknowns
- Which query-string keys, with what spelling and value grammar, make up the URL-state contract (filter text, open-section ids, flag page number, version page number), and which are shared across the environment page, flag page and versions page versus local to one page?
- How does URL state survive a POST, given that editRoute, publish and rollback re-render inline with 200/400/422 instead of redirecting — by echoing state as hidden fields in every write form, by putting the query string on each form's action URL, or by converting those handlers to POST-redirect-GET?
- If POST-redirect-GET is chosen, what happens to the current inline error rendering (400/422 with draft values and notices preserved) and to the field-granular replay behaviour that depends on re-rendering with the submitted draft in hand?
- Does "per-section open/closed state" mean the two page-level <section> blocks (Flags, Versions) only, or also every per-flag <details class="flag-row"> and the nested rollout/segment panels? The horizon-23 goal of not reopening rows after submit only works if the per-flag details are included.
- How does server-rendered open/closed state coexist with app.js, which already forces details.open = true for rows touched by carried-over edits — does the client keep that behaviour, or lose it once the server owns openness?
- Is the client-side live filter kept as progressive enhancement over an already server-filtered set, or removed outright? The answer decides whether data-search/data-filter stay and whether flag-list.spec.ts is rewritten or deleted.
- What is the flag filter's matching semantics server-side — today the client matches a data-search string of "key type on|off" lowercased; does the server reproduce that exact composite match, or narrow to key-prefix matching?
- What flag page size, and does flag paging interact with the filter (filter-then-page, totals over the filtered set) or page-then-filter?
- Is per-flag paging even meaningful given flags all live inside one snapshot document that is already fully read — i.e. is item 4's paging a render-cost win or purely a UI/scroll win?
- What should the sticky Section Nav contain on pages other than the environment page, and does "Versions" point at the on-page bounded list or at the /env/<env>/versions route?
- Does the e2e seed environment (3 flags, 1 version) still exercise filtering and paging meaningfully, or does the fixture need more seeded flags/versions first?
- How much branch surface do filter echo + open/closed state add to the view modules, and can the 100% coverage gate still be met without the view test files ballooning?

## Decisions needed
- Whether write POSTs become redirect-after-POST or keep inline re-rendering with state echoed through hidden form fields — the single choice that determines item 3's cost and whether the horizon-23 reopen-the-row workaround can be retired.
- Whether to introduce the shared query-string/URL-state module horizon 24 deliberately deferred as premature, once three or more pages read the same keys.
- Whether the client-side live filter is removed, kept as enhancement, or replaced — and correspondingly whether flag-list.spec.ts is rewritten, retargeted or deleted.
- The scope of "open/closed state": page sections only, or per-flag details rows and nested panels too — and how to encode that compactly in a URL without an unbounded key list.
- Whether item 4's paging applies to flags within the current snapshot at all, or whether filtering alone satisfies the intent.
- Whether the Section Nav is environment-page-only or a shared layout element.
- Whether the e2e seed fixture is enlarged, and if so whether existing specs' bare-URL assumptions and exact counts get rewritten in the same horizon.
- How much of items 3, 4 and 5 ships in one horizon versus splitting item 5 off.

## Research
- Read http-server.ts end to end — the dispatch()/match() 4-segment guard, branch ordering (features before segments before versions), the parseVersion/parseBaseVersion strict-regex + HttpError(400) style, and the three POST handlers that re-render inline.
- Read views/scripts/app.js lines ~31-50 (the [data-filter] live filter) and ~284-305 (carried-over-edit replay setting details.open = true) — the existing client-side owner of both mechanisms items 3 and 4 move to the server.
- Read e2e/flag-list.spec.ts (asserts live visible-row counts), e2e/support/fixtures.ts (InMemoryEnvironment.ports(), expandFlag()), and segment-upload-rollout.spec.ts where the flag row and rollouts panel are reopened by hand after a submit.
- Re-read horizon 24's shipped routes as they actually landed: version-list-page.ts and flag-page.ts (their versionsPath/flagPath helpers set the precedent any URL-state helper must match), and the page/pageSize query parsing it added — that is the seed of the URL-state contract, not a blank slate.
- Read snapshot-contents.ts to see how renderFlagCard emits the flag link and whether renderSnapshotContents takes a pre-sliced contents value — flag paging must slice at the same seam.
- Read every write form module and count the form actions needing query-state echoing; that is the real blast radius of item 3.
- Read stylesheet.ts STYLE_FILES and views/styles/ (per-feature sheets are 12-23 lines each) — item 5's CSS follows that pattern.
- Re-read decisions.md and discoveries.md for the horizon-18 app.js coverage decision and the horizon-10 no-listing rule.
- Check vitest.config.ts thresholds and the size of http-server.test.ts (~1593 lines) before deciding whether new route logic lands there or in a new module.

## Artifacts to inspect
packages/dashboard/src/infrastructure/: http-server.ts, http-primitives.ts, views/environment-page.ts, views/snapshot-contents.ts, views/scripts/app.js, views/feature-edit-form.ts, views/rollout-form.ts, views/segment-attach-form.ts, views/new-flag-form.ts, views/layout.ts, views/stylesheet.ts, views/styles/, views/segment-list-page.ts, views/version-page.ts · packages/dashboard/src/application/browse-environment.ts · packages/dashboard/e2e/{flag-list,segment-upload-rollout}.spec.ts, e2e/support/fixtures.ts · vitest.config.ts · docs/roadmaps/featuresync/{decisions,discoveries}.md

## Note
The previous content of this file (a brief for "create a flag with segments already attached") was superseded when the user redirected horizon 24 to dashboard navigation. That feature is still unbuilt; its open questions remain in blockers.md under horizon 23.
