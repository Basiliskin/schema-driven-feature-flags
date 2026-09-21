# Next horizon brief — horizon 26 (after horizon 25: URL state, server-side flag filter, Section Nav)

## Recommended scope
Keep horizon 26 to roughly four to six small phases and pick ONE of two directions rather than mixing them. Direction A (completion): extend the now-proven URL-state contract outward to the flag page and versions page and, if the operator need is confirmed, make the two page-level sections collapsible — but note this is a genuinely new feature (markup, CSS, tests, no existing disclosure markup) and that environment-page.ts likely needs splitting first, which alone is a phase. Direction B (stabilisation): burn down the accumulated blockers.md backlog, above all characterising the 200+422 concurrent-replay outcome and the pointer-read timing window, and deciding the standing rule for how much logic may live in the uncovered app.js — both of which have been open and re-asked across four horizons and now sit under every write form horizon 25 touched. Whichever direction, do not attempt flag-list paging (no justification exists, three-flag seed), do not enlarge the e2e seed casually (concurrent-edits.spec.ts asserts on it in four places), and budget explicitly for the 100% branch gate over hand-written HTML plus the growth of the already-1700-line http-server.test.ts.

## Binding decisions from horizon 25 — do NOT re-open
- The client-side live filter in app.js is RETAINED as progressive enhancement over the server-filtered set (user decision at the alignment checkpoint).
- The horizon-25 success bar was deliberately NARROWED to the environment page; URL state on the flag page and versions page, and collapsible page-level sections, were deferred, not forgotten.
- Redirect-after-POST stays rejected; write POSTs re-render inline with 200/400/422 and draft values.
- No flag-list paging key exists in the contract module.

## Unknowns
- Once the environment page's flag rows render open/closed from the URL, does the retained app.js force-open path (restore() walking ancestor details, and the changes-dialog 'keep' handler) visibly fight the server-rendered state in a real browser, and is the resulting URL-vs-DOM divergence acceptable to the user or does it need a fix?
- Does the retained client-side live filter, now layered over an already server-filtered set, confuse operators — e.g. typing in the search box narrows the visible rows but the URL still shows the old filter, and clearing the box does not restore rows the server dropped?
- Are the page-level 'Flags' and 'Version history' blocks actually wanted as collapsible disclosures at all, or was the operator complaint only ever about per-flag rows collapsing after a POST (which horizon 25 fixed)?
- What does URL state mean on the flag page and the versions page, where there is no flag list to filter — is the 'open' key meaningful there, or do those pages only need the paging keys plus state pass-through so navigation back to the environment page is lossless?
- Is there any real evidence that a flag list ever grows large enough to need paging or virtualisation, given no written justification exists anywhere in the repo and the e2e seed has three flags?
- Does the concurrent-replay 200+422 race (open blocker since horizon 19) get more or less reachable now that every write form round-trips extra query state, and did horizon 25's CI runs show any new flakiness at retries:0 with trace/screenshot/video off?
- Can the browser e2e suite be moved off the InMemoryEnvironment fake onto the LocalStack fixtures, which is what would be needed to e2e-cover the rollback POST's state echo (openWriter().rollback currently rejects in the fake)?
- Where should the growing set of path helpers live — they are still scattered across escape.ts, flag-page.ts, version-list-page.ts, segment-page.ts and segment-list-page.ts, and only versionsPath was folded into the new contract module?

## Decisions needed
- Whether horizon 26 is a feature horizon (extending URL state to the flag and versions pages, plus collapsible page sections) or a debt/blocker horizon (burning down the ~30 open blockers.md entries, notably the 200+422 replay race and the pointer-read timing window).
- Who owns openness when the URL, the draft-rejection rules in snapshot-contents.ts / feature-edit-form.ts / new-flag-form.ts, and app.js's force-open all have an opinion — the horizon-25 choice was 'additive override, URL may lag'; horizon 26 must either ratify that permanently or pick a single owner.
- Whether page-level sections become collapsible disclosures at all, and if so whether their state joins the existing 'open' key's namespace or gets its own key.
- Whether environment-page.ts gets split into smaller view modules, and along what seam (nav / filter form / flag list / versions) — this is a prerequisite choice for anything else landing there.
- Whether the retained app.js live filter stays indefinitely as progressive enhancement or is eventually reduced to a no-op once server filtering is trusted (the horizon-25 retention decision is binding for horizon 25 only).
- Whether path helpers are centralised into one module alongside url-state.ts, or stay co-located with the views that own each page.
- Whether the e2e suite moves onto LocalStack fixtures to reach the write paths the in-memory fake stubs out (rollback, segment publish), and who absorbs the CI wall-clock cost at retries:0.

## Research
- Read the shipped packages/dashboard/src/infrastructure/url-state.ts and its test to learn the actual key spellings, caps (filter length, open-id count and length) and the clamping split between parser and consumer, before assuming a new key can just be added.
- Read the shipped packages/dashboard/src/application/filter-flags.ts comment block to see which of the two documented matching quirks ('on' matching 'off', 'on' matching 'config') were deliberately preserved, before proposing any change to match semantics.
- Diff the post-horizon-25 environment-page.ts against its 165-line pre-horizon shape: it absorbed Section Nav, the GET filter form and row openness, so check whether it is now a god view that must be split before anything else lands in it.
- Read how state echo was actually implemented in the eight write forms (hidden inputs via a stateInputs()-style required parameter vs. form-action query strings) — whichever mechanism was chosen is the pattern any new form must follow, and determines whether a missed echo is a compile error or a silent bug.
- Re-read packages/dashboard/e2e/flag-list.spec.ts as rewritten this horizon, plus segment-picker.spec.ts and segment-upload-rollout.spec.ts, to see which reopen clicks were retired and which nested-panel clicks deliberately remain.
- Check http-server.test.ts's current line count and the shape of the new state-echo assertions; it was 1714 lines before this horizon and is the file any further form work grows.
- Re-read docs/roadmaps/featuresync/blockers.md: roughly thirty entries are open, several duplicated across horizons 19/20/21/23 (pointer-read window, 200+422 race, app.js coverage rule, orphaned objects, EDIT_PARSERS prototype-key 400). Decide whether the next horizon is a feature horizon or a blocker-burndown one before planning phases.
- Confirm whether stylesheet.ts's STYLE_FILES gained section-nav.css and how its position:sticky top/z-index was reconciled with the existing sticky .update-banner, before adding any further sticky chrome.

## Artifacts to inspect
packages/dashboard/src/infrastructure/: url-state.ts, url-state.test.ts, http-server.ts, http-server.test.ts, views/environment-page.ts, views/snapshot-contents.ts, views/feature-edit-form.ts, views/rollout-form.ts, views/segment-attach-form.ts, views/new-flag-form.ts, views/version-list-page.ts, views/flag-page.ts, views/escape.ts, views/stylesheet.ts, views/scripts/app.js · packages/dashboard/src/application/: filter-flags.ts, browse-environment.ts · packages/dashboard/e2e/: flag-list.spec.ts, concurrent-edits.spec.ts, support/fixtures.ts · vitest.config.ts · docs/roadmaps/featuresync/{blockers,decisions}.md
