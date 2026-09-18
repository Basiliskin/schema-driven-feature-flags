# FeatureSync — vision

**Objective:** Open-source, local-first feature flag + typed configuration runtime: Zod-schema-driven definitions, immutable versioned snapshots in S3, SNS change notifications, in-memory evaluation, managed via small CLI/UI, deployed into the user's own AWS account.

**Success:** Production-grade packages (@featuresync/core, /aws, /nestjs, CLI, dashboard) built DDD/SOLID/KISS/DRY, 100% test coverage enforced in CI, zero network I/O per flag evaluation, fail-safe atomic snapshot updates, reproducible CI via pinned snapshots; LocalStack used only via AWS SDK env config.

**domainShape:** business — flag definitions, targeting rules and snapshot versioning/rollback are rule-heavy domain logic.
