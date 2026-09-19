import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { CreateTopicCommand, DeleteTopicCommand, SNSClient, SubscribeCommand, UnsubscribeCommand } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Unsubscribe } from '@featuresync/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createS3SnapshotPublisher } from '../src/infrastructure/s3-snapshot-publisher.js';
import { createS3SnapshotSource } from '../src/infrastructure/s3-snapshot-source.js';
import { createSqsNotificationQueue } from '../src/infrastructure/sqs-notification-queue.js';

const ENVIRONMENT = 'integration';
const PUSH_ONLY_POLL_INTERVAL_MS = 10 * 60_000;
const WAIT_TIME_SECONDS = 1;
const QUIET_WINDOW_MS = 3_000;
const DELIVERY_TIMEOUT_MS = 10_000;

// Guards against creating topics and queues in real AWS when the local endpoints are not configured.
for (const name of ['AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL_SNS', 'AWS_ENDPOINT_URL_SQS']) {
  if (process.env[name] === undefined) throw new Error(`${name} must be set; see .env.example`);
}

const s3 = new S3Client({});
const sns = new SNSClient({});
const sqs = new SQSClient({});
const bucket = `featuresync-push-it-${randomUUID()}`;

interface Wiring {
  readonly topicArn: string;
  readonly queueUrl: string;
  readonly subscriptionArn: string;
}

const wire = async (): Promise<Wiring> => {
  const suffix = randomUUID();
  const { TopicArn: topicArn } = await sns.send(new CreateTopicCommand({ Name: `featuresync-it-${suffix}` }));
  const { QueueUrl: queueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: `featuresync-it-${suffix}` }));
  if (topicArn === undefined || queueUrl === undefined) throw new Error('topic or queue was not created');
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const queueArn = Attributes?.QueueArn;
  if (queueArn === undefined) throw new Error('queue has no ARN');
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: queueArn,
        Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
      },
    ],
  };
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: { Policy: JSON.stringify(policy) } }));
  const { SubscriptionArn: subscriptionArn } = await sns.send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: 'sqs',
      Endpoint: queueArn,
      Attributes: { RawMessageDelivery: 'true' },
      ReturnSubscriptionArn: true,
    }),
  );
  if (subscriptionArn === undefined) throw new Error('subscription was not created');
  return { topicArn, queueUrl, subscriptionArn };
};

const unwire = async ({ topicArn, queueUrl, subscriptionArn }: Wiring) => {
  await sns.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
  await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  await sns.send(new DeleteTopicCommand({ TopicArn: topicArn }));
};

const emptyBucket = async () => {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  if (Contents.length === 0) return;
  await s3.send(
    new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: Contents.map(({ Key }) => ({ Key })) } }),
  );
};

const snapshot = (label: string) => ({ label });

describe('push detection against LocalStack', () => {
  let wiring: Wiring | undefined;
  let unsubscribe: Unsubscribe | undefined;

  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  beforeEach(async () => {
    wiring = await wire();
  });

  afterEach(async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (wiring !== undefined) await unwire(wiring);
    wiring = undefined;
    await emptyBucket();
  });

  afterAll(async () => {
    await emptyBucket();
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    s3.destroy();
    sns.destroy();
    sqs.destroy();
  });

  it('delivers a publish and a rollback by push only, and nothing after Unsubscribe', async () => {
    if (wiring === undefined) throw new Error('expected the topic and queue to be wired');
    const publisher = createS3SnapshotPublisher({
      bucket,
      validate: () => ({ ok: true }),
      topicArn: wiring.topicArn,
      snsClient: sns,
    });
    const first = await publisher.publish(ENVIRONMENT, snapshot('first'));

    const source = createS3SnapshotSource({
      bucket,
      environment: ENVIRONMENT,
      pollIntervalMs: PUSH_ONLY_POLL_INTERVAL_MS,
      notificationQueue: createSqsNotificationQueue({
        queueUrl: wiring.queueUrl,
        client: sqs,
        waitTimeSeconds: WAIT_TIME_SECONDS,
      }),
    });
    await source.load();
    const onChange = vi.fn();
    if (source.subscribe === undefined) throw new Error('expected a subscribe method');
    unsubscribe = source.subscribe(onChange);
    const deliveredLast = (label: string) =>
      vi.waitFor(
        () => {
          expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining(snapshot(label)));
        },
        { timeout: DELIVERY_TIMEOUT_MS },
      );

    const second = await publisher.publish(ENVIRONMENT, snapshot('second'));
    await deliveredLast('second');
    await publisher.publish(ENVIRONMENT, snapshot('third'));
    await deliveredLast('third');

    await publisher.rollback(ENVIRONMENT, second);
    await deliveredLast('second');
    expect(onChange.mock.calls).toEqual([
      [expect.objectContaining(snapshot('second'))],
      [expect.objectContaining(snapshot('third'))],
      [expect.objectContaining({ ...snapshot('second'), reason: `Rollback to v${String(second)}` })],
    ]);

    unsubscribe();
    unsubscribe = undefined;
    await publisher.rollback(ENVIRONMENT, first);
    await sleep(QUIET_WINDOW_MS);

    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
