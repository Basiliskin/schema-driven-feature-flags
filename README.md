# FeatureSync

Local-first, schema-driven feature flags and typed configuration for TypeScript.

Flags are defined with Zod schemas, published as immutable versioned snapshots, and evaluated
entirely in memory — no network call per flag check. Everything runs in your own AWS account.

## Packages

| Package | Purpose |
|---|---|
| `@featuresync/core` | Domain model, rule evaluation and the in-memory flag client |

## Development

Requires Node 22 (see `.nvmrc`) and pnpm.

```sh
pnpm install
pnpm verify   # typecheck, lint, tests with 100% coverage
```

CI runs the same `pnpm verify`.

## License

Apache-2.0
