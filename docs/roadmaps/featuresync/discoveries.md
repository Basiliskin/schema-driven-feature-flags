# Discoveries
- 2026-09-18 | horizon 1 | repo | Greenfield: only docs/ and docker/docker-compose.yml (LocalStack, auth token from .env) exist [docker/docker-compose.yml] → all code paths are new.
- 2026-09-18 | horizon 1 | localstack | docker/volume/ holds a LocalStack TLS private key; it is gitignored [.gitignore] → keep it ignored, never commit volume.
- 2026-09-18 | horizon 1 | tooling | typescript-eslint 8.x refuses TypeScript 7; TS is pinned to ^6 [package.json] → keep TS 6 until typescript-eslint supports TS 7.
- 2026-09-18 | horizon 1 | tooling | import-x no-restricted-paths only fires with file globs (dir/**/*) plus the TypeScript resolver [eslint.config.js] → new layers need zones in that form.
