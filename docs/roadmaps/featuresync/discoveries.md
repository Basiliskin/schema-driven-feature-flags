# Discoveries
- 2026-09-18 | horizon 1 | repo | Greenfield: only docs/ and docker/docker-compose.yml (LocalStack, auth token from .env) exist [docker/docker-compose.yml] → all code paths are new.
- 2026-09-18 | horizon 1 | localstack | docker/volume/ holds a LocalStack TLS private key; it is gitignored [.gitignore] → keep it ignored, never commit volume.
- 2026-09-18 | horizon 1 | tooling | typescript-eslint 8.x refuses TypeScript 7; TS is pinned to ^6 [package.json] → keep TS 6 until typescript-eslint supports TS 7.
- 2026-09-18 | horizon 1 | tooling | import-x no-restricted-paths only fires with file globs (dir/**/*) plus the TypeScript resolver [eslint.config.js] → new layers need zones in that form.
- 2026-09-18 | horizon 1 | zod | z.json() reports a non-JSON value (e.g. NaN) at the value root, not the nested field [packages/core/src/domain/feature.ts] → field-level paths come only from registered feature schemas.
- 2026-09-18 | horizon 1 | evaluation | Snapshot `when` values are a scalar (equals) or a one-key operator object built from the operator registry [packages/core/src/domain/rule.ts] → new operators (percentage) — see horizon-01 roadmap.md
- 2026-09-18 | horizon 1 | evaluation | Snapshot boolean features have no default: an enabled one is on with zero rules, off when rules exist and none match [docs/spec/evaluation-semantics.md] → revisit if an — see horizon-01 roadmap.md
- 2026-09-18 | horizon 1 | api | Public index no longer exports parseSnapshot/evaluate/SNAPSHOT_SCHEMA_VERSION (small-surface rubric) [packages/core/src/index.ts] → CLI validate must re-export parseSnapshot deliberately.
- 2026-09-18 | horizon 1 | watch | fs.watch on a file stops after an atomic-save rename; the file source watches the directory and dedupes by content [packages/core/src/infrastructure/file-snapshot-source.ts] → reuse for any file watcher.
