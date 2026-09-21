# Next horizon brief — horizon 24 (after horizon 23: Segment List and picker-based attach)

## Recommended scope
One horizon, roughly the size of horizon 23 or slightly smaller, dedicated to the single remaining headline feature: creating a flag with one or more segments already attached, each with its own rollout percentage, landing in a single published snapshot version through the existing create/CAS/replay path. That is realistically a domain phase (widen the create FlagEdit and applyFlagEdit to emit a rules array, generalize the schemaVersion-2 guard), an application phase (createFeature emitting rules, extended CreateDraft echo-back), an interface phase (repeated segment+percentage rows in renderNewFlagForm fed by the listPublishedSegments contract shipped in horizon 23, plus the create form parser), and one Playwright proof in the existing LocalStack CI job, with unit tests carrying the 100% coverage threshold since integration and e2e contribute none. Resolving the bucketBy/salt question is a prerequisite inside this horizon, not a separate one. Everything else — attaching with a rollout in one step on the edit path, segment deletion/archival/GC, segment metadata beyond memberAttribute, auto-upgrading v1 snapshots, and horizon 22's orphaned-object cleanup — should stay out; pulling any of them in is what would make this horizon slip, and the rule-index ambiguity blocker is not made worse by the create path (create produces deterministic indices 0..N-1) so it need not be solved here.

## Unknowns
- Should creating a flag with segments widen the existing 'create' FlagEdit kind (preserving canReplayEdit's create-specific replay rule for free) or introduce a new kind, and if widened, does the create replay rule ('replays iff key absent in the BASE snapshot') still hold when the create also carries rules?
- Where do bucketBy and salt come from when the operator only enters a rollout percentage at create time — reuse the rollout form's defaults (bucketBy='userId', salt=''), derive salt from the flag/segment key, or ask the operator? Note salt='' would fail rolloutSchema's min(1).
- Should a rollout percentage be optional per attached segment at create time (rule with no rollout = 100%), or required for every attached segment?
- Should attachSegment itself gain an optional rollout (making attach-then-setRollout one round trip), or does per-segment rollout exist only on the create path?
- How should the schemaVersion-1 rejection guard in applyFlagEdit generalize — keyed on 'the edit produces a segment rule' rather than edit.kind === 'attachSegment' — and what error message does a create-with-segments against a v1 snapshot surface?
- What is the exact HTML form encoding for repeated segment rows in renderNewFlagForm (segmentKey[]/percentage[] vs indexed names), and how does the existing form-field parser in http-server.ts handle repeated field names today?
- What does CreateDraft echo back after a failed create — are partially filled segment rows preserved, and in what order?
- Can a create-with-segments be submitted when the environment has no published segments, and what does the form render then?
- Is horizon 22's orphaned-object cleanup still wanted at all, or has horizon 23's decision to list the <env>/segments/ prefix changed its premise (a prefix listing now makes orphans visible)?
- Does the segment picker on the new-flag form need the same 'unknown attribute' state as the attach form, and can a segment with no stored memberAttribute be attached at create time at all?

## Research
- Read packages/dashboard/src/domain/flag-edit.ts end to end: the create branch of applyFlagEdit, touchedFields (exhaustive over Exclude<FlagEdit,{kind:'create'}>), canReplayEdit's create special case, and the SEGMENT_NEEDS_SCHEMA_VERSION_2 guard condition.
- Read packages/dashboard/src/application/edit-feature.ts: the FlagEdit (9 kinds) and FlagEditFailure (11 kinds) exhaustive switches in describeEdit and editFailure, to count exactly what a widened create touches.
- Read packages/core/src/domain/rule.ts rolloutSchema and confirm bucketBy/salt are required and salt has min(1) — this decides whether an empty-salt default is even publishable.
- Read packages/dashboard/src/infrastructure/views/new-flag-form.ts and parseCreateForm + createDraftOf in http-server.ts to see how form fields are parsed and echoed, and whether repeated field names are supported by the existing parser.
- Read packages/dashboard/src/application/create-feature.ts to see the emitted feature object that today has no rules key.
- Inspect the shipped horizon-23 artifacts before planning: the listPublishedSegments port and use case, and createS3SegmentLister — the create form's picker should consume the same contract rather than a second source.
- Run `pnpm verify` (build, typecheck, lint, vitest --coverage) on a clean tree to confirm horizon 23 landed green and the 100% coverage threshold is the starting baseline.
- Grep for FIELD_MESSAGE and any test asserting its exact string, since adding parsers to EDIT_PARSERS changes that message automatically.
- Read packages/dashboard/e2e/support/localstack-fixtures.ts and the new segment-picker spec to see what seeding helpers already exist for a create-with-segments browser proof.
- Check whether any snapshot in the repo's fixtures or example environments is still schemaVersion 1, to size the v1 rejection path realistically.

## Decisions needed
- Widen the existing 'create' FlagEdit kind versus adding a new edit kind for create-with-segments — this determines whether replay/CAS semantics are inherited or reimplemented.
- Where bucketBy and salt come from for a create-time rollout, and whether the rollout form's current defaults (including salt='') are acceptable or must change.
- Whether rollout percentage becomes part of the attachSegment edit itself, or stays a separate setRollout addressed by rule index (the existing index-ambiguity blocker).
- Whether the schemaVersion-1 guard is restated as a general 'this edit introduces a segment rule' rule, or keeps enumerating edit kinds.
- How many segments a single create may attach (unbounded repeated rows versus a fixed small maximum), and whether rows are added server-side-only or need client JS in app.js.
- Whether horizon 22's orphaned-object cleanup is revived, rewritten against the now-available prefix listing, or formally retired.
- Whether auto-upgrading schemaVersion 1 snapshots to 2 is finally taken on, or stays a standing deferral.

## Artifacts to inspect
packages/dashboard/src/domain/flag-edit.ts; packages/dashboard/src/application/edit-feature.ts; packages/dashboard/src/infrastructure/http-server.ts; packages/dashboard/src/infrastructure/views/new-flag-form.ts; packages/dashboard/src/infrastructure/views/rollout-form.ts; packages/dashboard/src/infrastructure/views/segment-attach-form.ts; packages/dashboard/src/infrastructure/views/environment-page.ts; packages/dashboard/src/application/list-referenced-segments.ts; packages/dashboard/src/application/ports.ts; packages/aws/src/infrastructure/s3-segment-lister.ts; packages/aws/src/domain/segment-pointer.ts; packages/core/src/domain/rule.ts; packages/core/src/domain/snapshot.ts; packages/dashboard/e2e/support/localstack-fixtures.ts; packages/dashboard/integration/dashboard-segments.localstack.test.ts; vitest.config.ts; docs/roadmaps/featuresync/horizons/horizon-22-orphaned-object-cleanup-roadmap.json
