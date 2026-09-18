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
