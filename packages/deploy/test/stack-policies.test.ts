import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Statement {
  Sid?: string;
  Effect: string;
  Principal?: Json;
  Action: string | string[];
  Resource: Json;
  Condition?: Record<string, Record<string, Json>>;
}

interface Resource {
  Type: string;
  Condition?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, Json>;
}

interface Output {
  Condition?: string;
  Value: Json;
}

interface Template {
  Parameters: Record<string, { Default?: Json }>;
  Rules: Record<string, { Assertions: { Assert: Json }[] }>;
  Conditions: Record<string, Json>;
  Resources: Record<string, Resource>;
  Outputs: Record<string, Output>;
}

type Parameters = Record<string, string>;

const templateFile = new URL('../template/featuresync-stack.json', import.meta.url);
const template = JSON.parse(readFileSync(templateFile, 'utf8')) as Template;
const NO_VALUE = JSON.stringify({ Ref: 'AWS::NoValue' });

function isObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function evaluate(expression: Json, parameters: Parameters): Json {
  if (!isObject(expression)) return expression;
  if (typeof expression.Ref === 'string') {
    return parameters[expression.Ref] ?? template.Parameters[expression.Ref]?.Default ?? expression;
  }
  if (typeof expression.Condition === 'string') return conditionHolds(expression.Condition, parameters);
  const [fn, args] = Object.entries(expression)[0] as [string, Json[]];
  const values = args.map((arg) => evaluate(arg, parameters));
  if (fn === 'Fn::Equals') return values[0] === values[1];
  if (fn === 'Fn::And') return values.every(Boolean);
  if (fn === 'Fn::Or') return values.some(Boolean);
  if (fn === 'Fn::Not') return !values[0];
  throw new Error(`unsupported condition function ${fn}`);
}

function conditionHolds(name: string, parameters: Parameters): boolean {
  return evaluate(template.Conditions[name] as Json, parameters) === true;
}

function rulesHold(parameters: Parameters): boolean {
  return Object.values(template.Rules).every((rule) =>
    rule.Assertions.every(({ Assert }) => evaluate(Assert, parameters) === true),
  );
}

function resolve(value: Json, parameters: Parameters): Json {
  if (Array.isArray(value)) {
    return value.map((item) => resolve(item, parameters)).filter((item) => JSON.stringify(item) !== NO_VALUE);
  }
  if (!isObject(value)) return value;
  if ('Fn::If' in value) {
    const [condition, whenTrue, whenFalse] = value['Fn::If'] as [string, Json, Json];
    return resolve(conditionHolds(condition, parameters) ? whenTrue : whenFalse, parameters);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, parameters)]));
}

function deployed<T extends { Condition?: string }>(entries: Record<string, T>, parameters: Parameters): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([, entry]) => entry.Condition === undefined || conditionHolds(entry.Condition, parameters))
      .map(([name, entry]) => [name, resolve(entry as unknown as Json, parameters) as unknown as T]),
  );
}

function resourcesOfType(type: string, parameters: Parameters = {}): [string, Resource][] {
  return Object.entries(deployed(template.Resources, parameters)).filter(([, resource]) => resource.Type === type);
}

function managedPolicy(description: RegExp, parameters: Parameters = {}): Resource {
  const matches = resourcesOfType('AWS::IAM::ManagedPolicy', parameters).filter(([, policy]) =>
    description.test(policy.Properties?.Description as string),
  );
  expect(matches).toHaveLength(1);
  return (matches[0] as [string, Resource])[1];
}

function statementsOf(policy: Resource): Statement[] {
  const document = policy.Properties?.PolicyDocument as { Statement: Json[] };
  return document.Statement as unknown as Statement[];
}

function actionsOf(statements: Statement[]): string[] {
  return statements.flatMap((statement) => [statement.Action].flat()).sort();
}

function allPolicyStatements(parameters: Parameters): Statement[] {
  const types = ['AWS::IAM::ManagedPolicy', 'AWS::SQS::QueuePolicy', 'AWS::S3::BucketPolicy'];
  return types.flatMap((type) => resourcesOfType(type, parameters)).flatMap(([, policy]) => statementsOf(policy));
}

function referencedNames(value: Json): string[] {
  if (typeof value === 'string' || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(referencedNames);
  if (typeof value.Ref === 'string') return [value.Ref];
  if (Array.isArray(value['Fn::GetAtt'])) return [value['Fn::GetAtt'][0] as string];
  if (typeof value['Fn::Sub'] === 'string') {
    return [...value['Fn::Sub'].matchAll(/\$\{([^}.]+)/g)].map((match) => match[1] as string);
  }
  return Object.values(value).flatMap(referencedNames);
}

const EXISTING_BUCKET = 'shared-snapshots';
const EXISTING_TOPIC = 'arn:aws:sns:us-east-1:123456789012:shared-changes';
const fullMode: Parameters = {};
const queueOnlyMode: Parameters = { ExistingBucketName: EXISTING_BUCKET, ExistingTopicArn: EXISTING_TOPIC };
const modes = [
  ['full mode', fullMode],
  ['queue-only mode', queueOnlyMode],
] as const;
const sharedResources = ['SnapshotBucket', 'SnapshotBucketPolicy', 'ChangeTopic', 'PublisherPolicy'];
const environmentPrefix = { 'Fn::Sub': '${Environment}/*' };
const withListBucket = (parameters: Parameters): Parameters => ({ ...parameters, ReaderListBucket: 'true' });

describe('Publisher Policy', () => {
  const publisher = managedPolicy(/publisher/i);

  it('grants exactly the actions the publisher calls', () => {
    expect(actionsOf(statementsOf(publisher))).toEqual(['s3:GetObject', 's3:ListBucket', 's3:PutObject', 'sns:Publish']);
  });

  it('scopes object access to the environment prefix and publishing to the change topic', () => {
    const [objects, , publish] = statementsOf(publisher);
    expect(objects?.Resource).toEqual({ 'Fn::Sub': '${SnapshotBucket.Arn}/${Environment}/*' });
    expect(publish?.Resource).toEqual({ Ref: 'ChangeTopic' });
  });
});

describe.each(modes)('Reader Policy in %s', (_, mode) => {
  const reader = (parameters: Parameters = {}) => managedPolicy(/reading app/i, { ...mode, ...parameters });

  it('grants exactly read and queue-consume actions by default', () => {
    expect(actionsOf(statementsOf(reader()))).toEqual(['s3:GetObject', 'sqs:DeleteMessage', 'sqs:ReceiveMessage']);
  });

  it('adds s3:ListBucket only when ReaderListBucket is true', () => {
    expect(actionsOf(statementsOf(reader({ ReaderListBucket: 'false' })))).not.toContain('s3:ListBucket');
    expect(actionsOf(statementsOf(reader({ ReaderListBucket: 'true' })))).toEqual([
      's3:GetObject',
      's3:ListBucket',
      'sqs:DeleteMessage',
      'sqs:ReceiveMessage',
    ]);
  });

  it('consumes only the notification queue, never the dead-letter queue', () => {
    const consume = statementsOf(reader()).find((statement) => actionsOf([statement]).includes('sqs:ReceiveMessage'));
    expect(consume?.Resource).toEqual({ 'Fn::GetAtt': ['NotificationQueue', 'Arn'] });
  });
});

describe.each(modes)('every policy in %s', (_, mode) => {
  it('uses no wildcard in an allowed action', () => {
    const allowed = allPolicyStatements(withListBucket(mode)).filter((statement) => statement.Effect === 'Allow');
    expect(actionsOf(allowed).filter((action) => action.includes('*'))).toEqual([]);
  });

  it('uses no bare "*" resource and references only this stack', () => {
    const resources = allPolicyStatements(withListBucket(mode)).map((statement) => statement.Resource);
    expect(resources.flat()).not.toContain('*');
    const known = [...Object.keys(deployed(template.Resources, mode)), ...Object.keys(template.Parameters), 'AWS::Partition'];
    const unknown = referencedNames(resources).filter((name) => !known.includes(name));
    expect(unknown).toEqual([]);
  });

  it('limits every s3:ListBucket grant to the environment prefix', () => {
    const listBucket = allPolicyStatements(withListBucket(mode)).filter((statement) =>
      actionsOf([statement]).includes('s3:ListBucket'),
    );
    expect(listBucket).toHaveLength(mode === fullMode ? 2 : 1);
    for (const statement of listBucket) {
      expect(statement.Condition).toEqual({ StringLikeIfExists: { 's3:prefix': environmentPrefix } });
    }
  });
});

describe('notification queue', () => {
  it('accepts messages only from the change topic', () => {
    const [[, queuePolicy]] = resourcesOfType('AWS::SQS::QueuePolicy') as [[string, Resource]];
    expect(statementsOf(queuePolicy)).toEqual([
      expect.objectContaining({
        Principal: { Service: 'sns.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Condition: { ArnEquals: { 'aws:SourceArn': { Ref: 'ChangeTopic' } } },
      }),
    ]);
  });

  it('redrives to the dead-letter queue after MaxReceiveCount deliveries, default 5', () => {
    expect(template.Resources.NotificationQueue?.Properties?.RedrivePolicy).toEqual({
      deadLetterTargetArn: { 'Fn::GetAtt': ['NotificationDeadLetterQueue', 'Arn'] },
      maxReceiveCount: { Ref: 'MaxReceiveCount' },
    });
    expect(template.Parameters.MaxReceiveCount?.Default).toBe(5);
  });
});

describe('full mode', () => {
  it('creates the shared bucket, topic and Publisher Policy and retains the bucket', () => {
    expect(Object.keys(deployed(template.Resources, fullMode))).toEqual(expect.arrayContaining(sharedResources));
    expect(template.Resources.SnapshotBucket).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  });

  it('points the reader at the stack bucket and outputs its own bucket, topic and Publisher Policy', () => {
    const [objects, list] = statementsOf(managedPolicy(/reading app/i, withListBucket(fullMode)));
    expect(objects?.Resource).toEqual({ 'Fn::Sub': '${SnapshotBucket.Arn}/${Environment}/*' });
    expect(list?.Resource).toEqual({ 'Fn::GetAtt': ['SnapshotBucket', 'Arn'] });
    const outputs = deployed(template.Outputs, fullMode);
    expect(outputs.SnapshotBucketName?.Value).toEqual({ Ref: 'SnapshotBucket' });
    expect(outputs.ChangeTopicArn?.Value).toEqual({ Ref: 'ChangeTopic' });
    expect(outputs.PublisherPolicyArn?.Value).toEqual({ Ref: 'PublisherPolicy' });
  });
});

describe('queue-only mode', () => {
  const partitionBucket = `arn:\${AWS::Partition}:s3:::\${ExistingBucketName}`;

  it('creates no bucket, topic or Publisher Policy', () => {
    const names = Object.keys(deployed(template.Resources, queueOnlyMode));
    expect(names.filter((name) => sharedResources.includes(name))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['NotificationQueue', 'NotificationDeadLetterQueue', 'ReaderPolicy']));
  });

  it('subscribes the queue to the existing topic and accepts messages only from it', () => {
    const resources = deployed(template.Resources, queueOnlyMode);
    expect(resources.NotificationSubscription?.Properties?.TopicArn).toEqual({ Ref: 'ExistingTopicArn' });
    const [statement] = statementsOf(resources.NotificationQueuePolicy as Resource);
    expect(statement).toMatchObject({
      Principal: { Service: 'sns.amazonaws.com' },
      Condition: { ArnEquals: { 'aws:SourceArn': { Ref: 'ExistingTopicArn' } } },
    });
  });

  it('scopes the Reader Policy to the existing bucket through the partition', () => {
    const [objects, list] = statementsOf(managedPolicy(/reading app/i, withListBucket(queueOnlyMode)));
    expect(objects?.Resource).toEqual({ 'Fn::Sub': `${partitionBucket}/\${Environment}/*` });
    expect(list?.Resource).toEqual({ 'Fn::Sub': partitionBucket });
  });

  it('outputs the existing bucket and topic and no Publisher Policy', () => {
    const outputs = deployed(template.Outputs, queueOnlyMode);
    expect(outputs.SnapshotBucketName?.Value).toEqual({ Ref: 'ExistingBucketName' });
    expect(outputs.ChangeTopicArn?.Value).toEqual({ Ref: 'ExistingTopicArn' });
    expect(outputs).not.toHaveProperty('PublisherPolicyArn');
  });
});

describe('ExistingBucketName and ExistingTopicArn', () => {
  it('default to empty', () => {
    expect(template.Parameters.ExistingBucketName?.Default).toBe('');
    expect(template.Parameters.ExistingTopicArn?.Default).toBe('');
  });

  it.each([
    ['neither', fullMode, true],
    ['both', queueOnlyMode, true],
    ['only the bucket', { ExistingBucketName: EXISTING_BUCKET }, false],
    ['only the topic', { ExistingTopicArn: EXISTING_TOPIC }, false],
  ])('pass the template rules when %s is set: %s', (_, parameters, valid) => {
    expect(rulesHold(parameters)).toBe(valid);
  });

  it('create the shared resources only when both are empty', () => {
    expect(conditionHolds('CreateSharedResources', fullMode)).toBe(true);
    expect(conditionHolds('CreateSharedResources', { ExistingBucketName: EXISTING_BUCKET })).toBe(false);
    expect(conditionHolds('CreateSharedResources', { ExistingTopicArn: EXISTING_TOPIC })).toBe(false);
  });
});
