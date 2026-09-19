// Step 1 of 3 (`pnpm dev:setup`): start LocalStack, deploy the stack, seed versions 1 and 2.
// Records what it created in .dev-state.json for `pnpm dev:run` and `pnpm dev:cleanup`.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { COMPOSE, ENVIRONMENT, fail, localstackUp, log, readState, ROOT, writeState } from './common.js';

const {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStacksCommand,
  waitUntilStackCreateComplete,
} = await import('@aws-sdk/client-cloudformation');
const { createS3SnapshotPublisher } = await import('@featuresync/aws');
const { parseSnapshot } = await import('@featuresync/core');

const snapshot = (version, newDashboardEnabled, reason) => ({
  schemaVersion: 1,
  environment: ENVIRONMENT,
  version,
  createdAt: new Date().toISOString(),
  createdBy: 'dev-seed',
  previousVersion: version === 1 ? null : version - 1,
  reason,
  features: {
    'new-dashboard': {
      type: 'boolean',
      enabled: newDashboardEnabled,
      rules: [{ when: { isEmployee: true }, enabled: true }],
    },
    'payment-flow': {
      type: 'config',
      enabled: true,
      default: { provider: 'stripe', maxAmount: 1000 },
      rules: [{ when: { plan: 'enterprise' }, value: { provider: 'adyen', maxAmount: 10000 } }],
    },
  },
});

try {
  const existing = readState();
  if (existing !== undefined) {
    throw new Error(`A sandbox already exists (stack ${existing.stackName}). Use \`pnpm dev:run\`, or \`pnpm dev:cleanup\` first.`);
  }

  let startedLocalStack = false;
  if (await localstackUp()) {
    log('LocalStack already running — reusing it (cleanup will leave it running)');
  } else {
    if (!process.env.LOCALSTACK_AUTH_TOKEN) throw new Error('Set LOCALSTACK_AUTH_TOKEN in .env (copy .env.example)');
    log('Starting LocalStack (docker compose)…');
    execFileSync('docker', [...COMPOSE, 'up', '-d', '--wait'], { stdio: 'inherit' });
    startedLocalStack = true;
  }

  const stackName = `featuresync-dev-${randomUUID().slice(0, 8)}`;
  // Written before deploying so `pnpm dev:cleanup` can remove a half-created stack.
  writeState({ stackName, startedLocalStack });
  log(`Deploying stack ${stackName}…`);
  const cfn = new CloudFormationClient({});
  await cfn.send(
    new CreateStackCommand({
      StackName: stackName,
      TemplateBody: readFileSync(`${ROOT}packages/deploy/template/featuresync-stack.json`, 'utf8'),
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      Parameters: [
        { ParameterKey: 'AppName', ParameterValue: 'dev' },
        { ParameterKey: 'Environment', ParameterValue: ENVIRONMENT },
      ],
    }),
  );
  await waitUntilStackCreateComplete({ client: cfn, maxWaitTime: 120 }, { StackName: stackName });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  const state = {
    stackName,
    startedLocalStack,
    bucket: outputs.SnapshotBucketName,
    topicArn: outputs.ChangeTopicArn,
    // The stack returns a *.localhost.localstack.cloud queue URL; keep the path, use the configured endpoint.
    queueUrl: `http://localhost:4566${new URL(outputs.NotificationQueueUrl).pathname}`,
  };
  writeState(state);

  const publisher = createS3SnapshotPublisher({
    bucket: state.bucket,
    topicArn: state.topicArn,
    validate: (raw) => {
      const parsed = parseSnapshot(raw);
      return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
    },
  });
  await publisher.publish(ENVIRONMENT, snapshot(1, false, 'Initial flags'));
  await publisher.publish(ENVIRONMENT, snapshot(2, true, 'Launch new dashboard'));
  log(`Seeded ${ENVIRONMENT} with versions 1 and 2 in bucket ${state.bucket}`);
  log('Ready. Next: `pnpm dev:run`');
} catch (error) {
  fail(error);
}
