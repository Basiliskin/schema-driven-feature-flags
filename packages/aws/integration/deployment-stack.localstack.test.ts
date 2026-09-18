import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import { DeleteBucketCommand, DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { SNSClient } from '@aws-sdk/client-sns';
import { ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Unsubscribe } from '@featuresync/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createS3SnapshotPublisher } from '../src/infrastructure/s3-snapshot-publisher.js';
import { createS3SnapshotSource } from '../src/infrastructure/s3-snapshot-source.js';
import { createSqsNotificationQueue } from '../src/infrastructure/sqs-notification-queue.js';

const ENVIRONMENT = 'integration';
const PUSH_ONLY_POLL_INTERVAL_MS = 10 * 60_000;
const WAIT_TIME_SECONDS = 1;
const DELIVERY_TIMEOUT_MS = 10_000;
const STACK_TIMEOUT_MS = 120_000;
const TEMPLATE = new URL('../../deploy/template/featuresync-stack.json', import.meta.url);

// Guards against deploying stacks into real AWS when the local endpoints are not configured.
for (const name of [
  'AWS_ENDPOINT_URL_S3',
  'AWS_ENDPOINT_URL_SNS',
  'AWS_ENDPOINT_URL_SQS',
  'AWS_ENDPOINT_URL_CLOUDFORMATION',
]) {
  if (process.env[name] === undefined) throw new Error(`${name} must be set; see .env.example`);
}

const cloudFormation = new CloudFormationClient({});
const s3 = new S3Client({});
const sns = new SNSClient({});
const sqs = new SQSClient({});
const suffix = randomUUID().slice(0, 8);
const stackName = `featuresync-it-${suffix}`;
const queueOnlyStackName = `featuresync-it-${suffix}-queue`;

type Outputs = Record<string, string>;
type StackParameters = Record<string, string>;

const createStack = async (name: string, parameters: StackParameters): Promise<string> => {
  const { StackId } = await cloudFormation.send(
    new CreateStackCommand({
      StackName: name,
      TemplateBody: readFileSync(TEMPLATE, 'utf8'),
      Capabilities: ['CAPABILITY_IAM'],
      Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
    }),
  );
  if (StackId === undefined) throw new Error(`stack ${name} was not created`);
  await waitUntilStackCreateComplete(
    { client: cloudFormation, maxWaitTime: STACK_TIMEOUT_MS / 1000 },
    { StackName: StackId },
  );
  return StackId;
};

const deleteStack = async (stackId: string) => {
  await cloudFormation.send(new DeleteStackCommand({ StackName: stackId }));
  await waitUntilStackDeleteComplete(
    { client: cloudFormation, maxWaitTime: STACK_TIMEOUT_MS / 1000 },
    { StackName: stackId },
  );
};

const describeOutputs = async (stackId: string): Promise<Outputs> => {
  const { Stacks = [] } = await cloudFormation.send(new DescribeStacksCommand({ StackName: stackId }));
  const entries = (Stacks[0]?.Outputs ?? []).map(({ OutputKey = '', OutputValue = '' }): [string, string] => [
    OutputKey,
    OutputValue,
  ]);
  return Object.fromEntries(entries);
};

const output = (outputs: Outputs, key: string): string => {
  const value = outputs[key];
  if (value === undefined) throw new Error(`stack has no ${key} output`);
  return value;
};

const emptyVersionedBucket = async (bucket: string) => {
  const { Versions = [], DeleteMarkers = [] } = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket }));
  const objects = [...Versions, ...DeleteMarkers].map(({ Key, VersionId }) => ({ Key, VersionId }));
  if (objects.length > 0) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
};

const snapshot = (version: number) => ({ version });

describe('deployment stack against LocalStack', () => {
  let stackId: string | undefined;
  let queueOnlyStackId: string | undefined;
  let outputs: Outputs = {};
  let queueOnlyOutputs: Outputs = {};

  beforeAll(async () => {
    stackId = await createStack(stackName, { AppName: `it-${suffix}`, Environment: ENVIRONMENT });
    outputs = await describeOutputs(stackId);
    queueOnlyStackId = await createStack(queueOnlyStackName, {
      AppName: `it-${suffix}-second`,
      Environment: ENVIRONMENT,
      ExistingBucketName: output(outputs, 'SnapshotBucketName'),
      ExistingTopicArn: output(outputs, 'ChangeTopicArn'),
    });
    queueOnlyOutputs = await describeOutputs(queueOnlyStackId);
  }, 2 * STACK_TIMEOUT_MS);

  afterAll(async () => {
    if (queueOnlyStackId !== undefined) await deleteStack(queueOnlyStackId);
    if (stackId !== undefined) {
      const bucket = outputs.SnapshotBucketName;
      if (bucket !== undefined) await emptyVersionedBucket(bucket);
      await deleteStack(stackId);
      if (bucket !== undefined) await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    for (const client of [cloudFormation, s3, sns, sqs]) client.destroy();
  }, 2 * STACK_TIMEOUT_MS);

  it('pushes a published version through the stack topic and queue to the source', async () => {
    const bucket = output(outputs, 'SnapshotBucketName');
    const publisher = createS3SnapshotPublisher({
      bucket,
      validate: () => ({ ok: true }),
      topicArn: output(outputs, 'ChangeTopicArn'),
      snsClient: sns,
    });
    const first = await publisher.publish(ENVIRONMENT, snapshot(1));

    const source = createS3SnapshotSource({
      bucket,
      environment: ENVIRONMENT,
      pollIntervalMs: PUSH_ONLY_POLL_INTERVAL_MS,
      notificationQueue: createSqsNotificationQueue({
        queueUrl: output(outputs, 'NotificationQueueUrl'),
        client: sqs,
        waitTimeSeconds: WAIT_TIME_SECONDS,
      }),
    });
    await expect(source.load()).resolves.toEqual(snapshot(first));
    const onChange = vi.fn();
    if (source.subscribe === undefined) throw new Error('expected a subscribe method');
    const unsubscribe: Unsubscribe = source.subscribe(onChange);

    try {
      const second = await publisher.publish(ENVIRONMENT, snapshot(2));
      expect(second).toBe(first + 1);
      await vi.waitFor(
        () => {
          expect(onChange).toHaveBeenLastCalledWith(snapshot(second));
        },
        { timeout: DELIVERY_TIMEOUT_MS },
      );
    } finally {
      unsubscribe();
    }
  });

  it('attaches a queue-only stack to the shared bucket and topic', async () => {
    expect(queueOnlyOutputs).toMatchObject({
      SnapshotBucketName: output(outputs, 'SnapshotBucketName'),
      ChangeTopicArn: output(outputs, 'ChangeTopicArn'),
    });
    expect(queueOnlyOutputs).not.toHaveProperty('PublisherPolicyArn');
    const queueUrl = output(queueOnlyOutputs, 'NotificationQueueUrl');
    expect(queueUrl).not.toBe(output(outputs, 'NotificationQueueUrl'));

    const publisher = createS3SnapshotPublisher({
      bucket: output(outputs, 'SnapshotBucketName'),
      validate: () => ({ ok: true }),
      topicArn: output(outputs, 'ChangeTopicArn'),
      snsClient: sns,
    });
    const version = await publisher.publish(ENVIRONMENT, snapshot(3));

    await vi.waitFor(
      async () => {
        const { Messages = [] } = await sqs.send(
          new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: WAIT_TIME_SECONDS }),
        );
        expect(Messages.map(({ Body = '' }) => JSON.parse(Body) as unknown)).toContainEqual(
          expect.objectContaining({ environment: ENVIRONMENT, version }),
        );
      },
      { timeout: DELIVERY_TIMEOUT_MS },
    );
  });
});
