# Change notification

This is the contract between the snapshot publisher and every application that listens for new
versions. The publisher sends one message each time a new version goes live; `@featuresync/aws`
builds and parses it in `src/domain/change-notification.ts`.

## The message is only a hint

The [current pointer](s3-layout.md#current-pointer) (`<env>/current.json`) stays the source of truth.
A notification tells an application "look at the pointer now" — nothing more. Delivery is:

- **at-least-once** — the same message may arrive twice;
- **unordered** — version 44 may arrive before version 43;
- **lossy** — a message may never arrive.

An application therefore never trusts the notification's `version` as the live one. On any
notification it re-reads `current.json` and follows the version named there, and it keeps polling
the pointer so a lost message only delays an update.

## Message

```json
{
  "schemaVersion": 1,
  "environment": "production",
  "version": 43,
  "snapshotKey": "production/snapshots/43.json"
}
```

| Field | Rule |
|---|---|
| `schemaVersion` | The message format version. Currently `1`. |
| `environment` | Non-empty string with no `/`, as in [s3-layout.md](s3-layout.md#key-scheme). |
| `version` | Positive integer: the version that just went live. |
| `snapshotKey` | Must equal `<environment>/snapshots/<version>.json`. |

Unknown extra fields are ignored. A message is rejected when it is not JSON, a field is missing or
invalid, or `snapshotKey` disagrees with `environment` and `version`.

## Delivery shapes

A queue subscribed to the topic receives the message in one of two shapes, depending on whether
raw message delivery is enabled on the subscription. The parser accepts both.

Raw — the message itself:

```json
{"schemaVersion":1,"environment":"production","version":43,"snapshotKey":"production/snapshots/43.json"}
```

Wrapped in an SNS envelope — the message is a JSON **string** in `Message`:

```json
{
  "Type": "Notification",
  "MessageId": "…",
  "TopicArn": "arn:aws:sns:…",
  "Message": "{\"schemaVersion\":1,\"environment\":\"production\",\"version\":43,\"snapshotKey\":\"production/snapshots/43.json\"}"
}
```

Any other envelope type (`SubscriptionConfirmation`, `UnsubscribeConfirmation`) is rejected, as is an
envelope whose `Message` is not a string.

## Consuming notifications

Pass a queue to the S3 source to receive changes as soon as they are published, instead of waiting
for the next poll:

```ts
const source = createS3SnapshotSource({
  bucket: 'flags',
  environment: 'production',
  notificationQueue: createSqsNotificationQueue({ queueUrl }),
});
```

Polling keeps running next to the queue, so a lost or delayed notification is still picked up on the
next poll. The source applies these rules to every notification:

- **Environment filtering.** A notification for another environment is acknowledged and dropped
  without reading S3, so one topic can serve every environment.
- **Rollback Confirmation.** The notification is only a hint. For a matching environment the source
  re-reads `current.json` and loads the Snapshot the Current Pointer names, not the one in the
  message. A rollback to a lower version is delivered because the pointer confirms it; a stale or
  out-of-order notification delivers whatever is current.
- **Version dedupe.** The Snapshot is delivered only when the pointer's version differs from the one
  already loaded, so a redelivered or duplicate notification calls `onChange` at most once. Push and
  poll loads run one at a time, so an older Snapshot is never delivered after a newer one.
- **Poison Message policy.** A message that cannot be parsed is deleted immediately; retrying it can
  never succeed. When loading the Snapshot fails, the message is left on the queue so SQS redelivers
  it. Configure a dead-letter queue with a `maxReceiveCount` (for example 5) on the queue's redrive
  policy, or a Snapshot that keeps failing to load is retried forever. The
  [deployment stack](../deploy.md#why-the-dead-letter-queue-is-not-optional) creates this
  dead-letter queue for every app's queue.
- **Unsubscribe.** The function `subscribe` returns stops the queue and the poll timer at once. A load
  already in flight finishes but does not call `onChange`.

The queue needs a policy that lets the topic's ARN call `sqs:SendMessage`, and the subscription may use
either delivery shape above.
