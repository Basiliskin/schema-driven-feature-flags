# Planning Brief — Horizon 8 (written by horizon 7 PLAN, 2026-09-18)

## Recommended scope
Horizon 8 should finish the push feature started in horizon 7. That means wiring the Notification Queue into createS3SnapshotSource (version dedupe, rollback confirmation, and one Unsubscribe that stops both loops), adding the thin CLI --topic-arn/FEATURESYNC_TOPIC_ARN option, and proving publish -> SNS -> SQS -> onChange on LocalStack with SERVICES=s3,sns,sqs. It should first confirm that the horizon-7 contract, publisher and queue modules shipped as planned, and settle the placement, rollback and poison-message decisions. Keep infrastructure provisioning, automatic per-instance queue creation, real-AWS IAM checks and NestJS-specific wiring out of scope.

Deferred phase candidates from horizon 7: s3-source-push-detection, cli-topic-arn, localstack-push-proof (see horizon-07 roadmap.json `deferred`).

## Unknowns
- Does horizon 7's NotificationQueue interface (start(handler) -> stop) match what createS3SnapshotSource needs, e.g. sync stop, handler errors, and delete-after-handle ordering?
- Does LocalStack deliver SNS->SQS messages in both RawMessageDelivery true/false shapes the way AWS does, so the horizon-7 parser covers what arrives?
- How should poison or repeatedly failing messages be handled: delete after N failures, or leave them to a user-configured DLQ?
- Can a push-triggered load race a concurrent poll/reconcile load in the shared loaded closure, and does ordering matter?
- Did horizon 7 keep publish/rollback returning Promise<number> with onNotifyError plus a console.warn default, as the CLI phase assumes?

## Research
- Re-read createS3SnapshotSource to confirm readPointer/loadVersion/loaded are still private closures and see how a notification handler can reuse them without duplicating code
- Read the shipped sqs-notification-queue.ts and sns-change-notifier.ts to confirm the exact interface, abort behaviour and exported types
- Check the LocalStack SNS->SQS subscription docs (queue policy, RawMessageDelivery, AWS_ENDPOINT_URL_SNS/SQS) against the pinned LocalStack image
- Read the existing s3-snapshot-source.localstack.test.ts fixture pattern to reuse for the SNS/SQS push test
- Read CLI main.ts publisherFor and the reportPublishError tests to see where --topic-arn and the warning go

## Decisions needed
- Whether push detection lives inside createS3SnapshotSource or comes from extracting a shared loaded-state holder
- Rollback policy for lower-version notifications: always confirm against current.json, or rely on polling/reconcile
- Poison-message policy: delete unparseable/failed messages immediately vs leave for redelivery/DLQ
- CLI exit code on notify failure: 0 with a warning vs a distinct nonzero code
- Whether parseChangeNotification and the NotificationQueue type are exported as public @featuresync/aws API

## Artifacts to inspect
- packages/aws/src/infrastructure/s3-snapshot-source.ts
- packages/aws/src/infrastructure/sqs-notification-queue.ts
- packages/aws/src/infrastructure/s3-snapshot-publisher.ts
- packages/aws/src/domain/change-notification.ts
- packages/core/src/application/snapshot-source.port.ts
- packages/cli/src/main.ts
- packages/aws/integration/s3-snapshot-source.localstack.test.ts
- docker/docker-compose.yml
- docs/spec/change-notification.md
- vitest.config.ts
