# Manual QA on LocalStack

```sh
cp .env.example .env      # once; set LOCALSTACK_AUTH_TOKEN
pnpm dev:setup            # 1. build, start LocalStack, deploy the stack, seed versions 1 and 2
pnpm dev:run              # 2. dashboard + live SDK reader; PORT=4460 pnpm dev:run if 4455 is taken
pnpm dev:cleanup          # 3. delete the stack and its bucket; stops LocalStack if setup started it
```

`dev:setup` starts LocalStack if it is not running, deploys the stack (`packages/deploy`) and seeds
environment `dev`. It records what it created in `examples/local-dashboard/.dev-state.json` (git-ignored).
`dev:run` serves the dashboard over that sandbox; **Ctrl-C** stops only the dashboard, so you can rebuild
and run it again against the same data. `dev:cleanup` removes everything setup created.

The terminal prints lines like `app sees → v2 new-dashboard(employee/customer)=true/false ...` — that is an
app using the SDK (S3 poll + SQS push). Every change you make should show up there within seconds.

## What to try in the browser

- **Browse** — versions list, feature contents (boolean + config with rules), `/env/dev/versions/1`.
- **Restore** v1 → it is republished as v3, new "app sees" line.
- **Edit a flag** — toggle _Enabled_, or change _Default JSON_ of `payment-flow` → new version, "app sees" updates.
- **Bad input** — `{not json` as a default, or an invalid snapshot in _Publish_ → error, draft kept, no new version.
- **Stale edit** — two tabs, save in one, then the other. A different field → saved on top of it with a note;
  the same field or a deleted flag → conflict notice with _Review changes_.
- **Update banner** — two tabs, publish in one; the other shows _Someone published version N_ within 15 s.
- **Merge a draft** — two tabs, publish in one, then paste-publish in the other → _Review changes_ opens the
  field-by-field merge; conflicting fields must be chosen before _Apply to my draft_.
- **Edit after rollback** — restore v1, then toggle a flag → the next version, no error.

## Where the dashboard answers

The dashboard only answers requests whose `Host` is `127.0.0.1:<port>` or `localhost:<port>`, on the port it
listens on; any other `Host` (a rebound domain, `[::1]`, another port) gets a plain-text 403. POSTs also need
the matching `Origin`. Putting the dashboard behind a proxy, even on localhost, is unsupported.

## Automated browser tests

`pnpm --filter @featuresync/dashboard test:e2e` runs the Playwright suite (`packages/dashboard/e2e`) against
an in-memory dashboard, no LocalStack needed. It uses the installed Google Chrome; set `PLAYWRIGHT_CHANNEL=`
(empty) to use Playwright's own Chromium after `npx playwright install chromium`, e.g. in CI.

## Known gaps seen 2026-09-19 (fixed in horizon 12)

- CLI `publish` stored the file body verbatim; the publisher now stamps `version`, `previousVersion` and
  `createdAt`, and refuses a body whose `environment` differs from `--env`.
- A dashboard POST with no `Origin` header was not rejected; it now gets 403, like a foreign `Origin`.

pnpm dev:setup # 1. build, start LocalStack if it isn't running, deploy the stack, seed versions 1 and 2
pnpm dev:run # 2. dashboard + live SDK reader (PORT=4460 pnpm dev:run if 4455 is taken)
pnpm dev:cleanup # 3. delete the bucket and stack; stops LocalStack only if setup started it
