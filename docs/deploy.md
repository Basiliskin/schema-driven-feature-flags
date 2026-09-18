# Deploying FeatureSync to your AWS account

[`packages/deploy/template/featuresync-stack.json`](../packages/deploy/template/featuresync-stack.json)
is a plain CloudFormation template. It creates everything FeatureSync needs, with nothing public:

| Resource | Created in | Purpose |
|---|---|---|
| Snapshot bucket | full mode only | Versioned, SSE-S3, public access blocked, TLS required. Holds `<env>/snapshots/<n>.json` and `<env>/current.json` ([layout](spec/s3-layout.md)). |
| Change topic | full mode only | SNS topic the publisher notifies after each publish or rollback ([contract](spec/change-notification.md)). |
| Publisher Policy | full mode only | Managed policy for whoever runs `featuresync publish` / `rollback`. |
| Notification queue + DLQ | every stack | One SQS queue per reading app, subscribed to the topic, with a dead-letter queue. |
| Reader Policy | every stack | Managed policy for that reading app: read its environment, consume its queue. |

## Topology: one full stack, then one queue-only stack per reading app

The bucket and topic are shared. Deploy them **once**, in a *full-mode* stack, and give every other
reading app its own *queue-only* stack that attaches to them. Never deploy a second full-mode stack
for another app: it would get its own empty bucket and a topic nobody publishes to.

A full-mode stack also creates one queue and Reader Policy for the app named in its `AppName`, so
that app needs no queue-only stack of its own.

```text
featuresync-production            (full mode, AppName=checkout)
  ├─ snapshot bucket, change topic, Publisher Policy
  └─ queue + DLQ + Reader Policy for "checkout"
featuresync-production-search     (queue-only, AppName=search)
  └─ queue + DLQ + Reader Policy for "search", subscribed to the shared topic
featuresync-production-billing    (queue-only, AppName=billing)
  └─ ...
```

Queue names are `<stack name>-<AppName>` and `<stack name>-<AppName>-dlq`, and SQS allows at most 80
characters, so keep both short.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `AppName` | — (required) | Reading app that owns this stack's queue and Reader Policy. |
| `Environment` | — (required) | Key prefix in the bucket (`production`, `staging`, ...). No `/`. |
| `MaxReceiveCount` | `5` | Deliveries before a notification that keeps failing moves to the DLQ. |
| `RawMessageDelivery` | `true` | `true` delivers the bare notification, `false` the SNS envelope. The reader accepts both. |
| `ReaderListBucket` | `false` | Also grant the Reader Policy `s3:ListBucket` on `<env>/*`, so `featuresync pull` with reader credentials reports a missing version as `SNAPSHOT_NOT_FOUND` instead of `ACCESS_DENIED`. |
| `ExistingBucketName` | empty | Queue-only mode: the full stack's `SnapshotBucketName` output. |
| `ExistingTopicArn` | empty | Queue-only mode: the full stack's `ChangeTopicArn` output. |

Set `ExistingBucketName` and `ExistingTopicArn` together or leave both empty; the template rejects
one without the other.

Outputs: `Environment`, `SnapshotBucketName`, `ChangeTopicArn`, `NotificationQueueUrl`,
`NotificationQueueArn`, `NotificationDeadLetterQueueArn`, `ReaderPolicyArn`, and — full mode only —
`PublisherPolicyArn`. In queue-only mode `SnapshotBucketName` and `ChangeTopicArn` echo the shared
resources, so every stack's outputs are enough to configure its app.

## 1. Deploy the full-mode stack

```sh
aws cloudformation deploy \
  --stack-name featuresync-production \
  --template-file packages/deploy/template/featuresync-stack.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AppName=checkout Environment=production MaxReceiveCount=5
```

Read the outputs the other stacks and apps need:

```sh
output() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}
BUCKET=$(output featuresync-production SnapshotBucketName)
TOPIC_ARN=$(output featuresync-production ChangeTopicArn)
PUBLISHER_POLICY_ARN=$(output featuresync-production PublisherPolicyArn)
```

## 2. Deploy one queue-only stack per additional reading app

```sh
aws cloudformation deploy \
  --stack-name featuresync-production-search \
  --template-file packages/deploy/template/featuresync-stack.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AppName=search Environment=production \
    ExistingBucketName="$BUCKET" ExistingTopicArn="$TOPIC_ARN"
```

Use the same `Environment` as the full stack; the Reader Policy only covers `<Environment>/*`.
The same template works from code with `@aws-sdk/client-cloudformation` `CreateStackCommand`
(`Capabilities: ['CAPABILITY_NAMED_IAM']`), which is how the LocalStack integration test deploys it.

## 3. Attach the policies

The stacks create managed policies but attach them to nobody. Attach the Publisher Policy to the
role or user that runs the CLI:

```sh
aws iam attach-role-policy --role-name featuresync-publisher --policy-arn "$PUBLISHER_POLICY_ARN"
# or: aws iam attach-user-policy --user-name ci-publisher --policy-arn "$PUBLISHER_POLICY_ARN"
```

Attach each app's own Reader Policy to that app's role — never another app's, since it grants that
app's queue:

```sh
aws iam attach-role-policy --role-name checkout-service \
  --policy-arn "$(output featuresync-production ReaderPolicyArn)"
aws iam attach-role-policy --role-name search-service \
  --policy-arn "$(output featuresync-production-search ReaderPolicyArn)"
```

| Policy | Grants |
|---|---|
| Publisher | `s3:GetObject`, `s3:PutObject` on `<env>/*`; `s3:ListBucket` limited to prefix `<env>/*`; `sns:Publish` on the topic. |
| Reader | `s3:GetObject` on `<env>/*`; `sqs:ReceiveMessage`, `sqs:DeleteMessage` on its own queue; `s3:ListBucket` on `<env>/*` only with `ReaderListBucket=true`. |

## 4. Wire the outputs into FeatureSync

Publisher side — the CLI takes the bucket and topic from flags or environment variables:

```sh
export FEATURESYNC_BUCKET="$BUCKET"
export FEATURESYNC_TOPIC_ARN="$TOPIC_ARN"
featuresync publish --env production ./featuresync.json
# or: featuresync publish --env production --bucket "$BUCKET" --topic-arn "$TOPIC_ARN" ./featuresync.json
```

Reading app — pass its stack's `SnapshotBucketName`, `Environment` and `NotificationQueueUrl`:

```ts
import { createS3SnapshotSource, createSqsNotificationQueue } from '@featuresync/aws';

const source = createS3SnapshotSource({
  bucket: process.env.FEATURESYNC_BUCKET!,
  environment: 'production',
  notificationQueue: createSqsNotificationQueue({ queueUrl: process.env.FEATURESYNC_QUEUE_URL! }),
});
```

## Why the dead-letter queue is not optional

When a notification arrives but loading the snapshot fails, the reader leaves the message on the
queue so SQS redelivers it ([poison message policy](spec/change-notification.md#consuming-notifications)).
Without a redrive limit a snapshot that can never load would be retried forever. Every stack
therefore creates a DLQ and moves a message there after `MaxReceiveCount` deliveries.

A message in the DLQ means an app could not load a published snapshot. Polling still converges once
the cause is fixed, so the message is diagnostic, not lost work. Inspect and redrive it with:

```sh
DLQ_ARN=$(output featuresync-production NotificationDeadLetterQueueArn)
aws sqs get-queue-attributes --attribute-names ApproximateNumberOfMessages \
  --queue-url "$(aws sqs get-queue-url --queue-name "${DLQ_ARN##*:}" --query QueueUrl --output text)"
aws sqs start-message-move-task --source-arn "$DLQ_ARN"
```

## Deleting a stack

Delete queue-only stacks first, then the full stack. The snapshot bucket has
`DeletionPolicy: Retain`: it survives stack deletion, so your published history is never removed by
accident. To remove it you must empty every object version and delete the bucket by hand. The topic,
queues and policies are deleted with their stacks.

## Manual least-privilege check on real AWS

LocalStack does not enforce IAM for this setup, so CI proves the policies only by static tests of
the template. This recipe is the real-AWS half of that check and closes the open
"IAM least-privilege cannot be verified on LocalStack" question. Run it in a test account with
admin credentials; `ACCOUNT` is that account's id.

1. **Deploy a throwaway stack.**

   ```sh
   aws cloudformation deploy --stack-name featuresync-verify \
     --template-file packages/deploy/template/featuresync-stack.json \
     --capabilities CAPABILITY_NAMED_IAM --parameter-overrides AppName=verify Environment=verify
   BUCKET=$(output featuresync-verify SnapshotBucketName)
   TOPIC_ARN=$(output featuresync-verify ChangeTopicArn)
   ```

   Expected: stack `CREATE_COMPLETE`.

2. **Create one role per policy.**

   ```sh
   TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::'"$ACCOUNT"':root"},"Action":"sts:AssumeRole"}]}'
   for r in publisher reader; do aws iam create-role --role-name "featuresync-verify-$r" --assume-role-policy-document "$TRUST"; done
   aws iam attach-role-policy --role-name featuresync-verify-publisher --policy-arn "$(output featuresync-verify PublisherPolicyArn)"
   aws iam attach-role-policy --role-name featuresync-verify-reader --policy-arn "$(output featuresync-verify ReaderPolicyArn)"
   as() {  # run a command as featuresync-verify-$1
     read -r AK SK ST < <(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/featuresync-verify-$1" \
       --role-session-name verify --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)
     shift; AWS_ACCESS_KEY_ID=$AK AWS_SECRET_ACCESS_KEY=$SK AWS_SESSION_TOKEN=$ST "$@"
   }
   ```

   Expected: both roles exist. Wait ~10 seconds for IAM to propagate.

3. **Publisher publishes.**
   `as publisher featuresync publish --env verify --bucket "$BUCKET" --topic-arn "$TOPIC_ARN" ./featuresync.json`
   Expected: success, exit 0, no notification warning on stderr.

4. **Reader reads but cannot write.**
   `as reader aws s3api get-object --bucket "$BUCKET" --key verify/current.json /dev/stdout` — expected: success.
   `as reader aws s3api put-object --bucket "$BUCKET" --key verify/snapshots/999.json --body ./featuresync.json` — expected: `AccessDenied`.

5. **Reader cannot publish to the topic.**
   `as reader aws sns publish --topic-arn "$TOPIC_ARN" --message x` — expected: `AuthorizationError`.

6. **A missing version is reported as missing, not denied.**
   `as publisher featuresync pull --env verify --version 999 --out /tmp/verify.json --bucket "$BUCKET"`
   Expected: exit 3 with `Snapshot version not found; was it published to this environment?` —
   the `SNAPSHOT_NOT_FOUND` result. The same command as `reader` prints `Access denied; ...`
   (`ACCESS_DENIED`) unless the stack was deployed with `ReaderListBucket=true`.

7. **Clean up.**

   ```sh
   for r in publisher reader; do
     aws iam detach-role-policy --role-name "featuresync-verify-$r" \
       --policy-arn "$(output featuresync-verify "$( [ $r = publisher ] && echo Publisher || echo Reader )PolicyArn")"
     aws iam delete-role --role-name "featuresync-verify-$r"
   done
   aws cloudformation delete-stack --stack-name featuresync-verify
   aws cloudformation wait stack-delete-complete --stack-name featuresync-verify
   aws s3api delete-objects --bucket "$BUCKET" --delete "$(aws s3api list-object-versions --bucket "$BUCKET" \
     --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' --output json)"
   aws s3api delete-bucket --bucket "$BUCKET"
   ```

   Expected: stack `DELETE_COMPLETE`, bucket gone.

If step 4's `put-object` or step 5 succeeds, the policies grant more than they should; if step 6
prints `Access denied` for the publisher, the `s3:ListBucket` condition is not taking effect.
