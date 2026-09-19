// Step 3 of 3 (`pnpm dev:cleanup`): delete what `pnpm dev:setup` created — the bucket, the stack, and
// LocalStack itself if setup started it. Safe to run twice.
import { execFileSync } from 'node:child_process';
import { clearState, COMPOSE, fail, localstackUp, log, readState } from './common.js';

const {
  CloudFormationClient,
  DeleteStackCommand,
  waitUntilStackDeleteComplete,
} = await import('@aws-sdk/client-cloudformation');
const { S3Client, ListBucketsCommand, ListObjectVersionsCommand, DeleteObjectsCommand, DeleteBucketCommand } =
  await import('@aws-sdk/client-s3');

const s3 = new S3Client({});

// The bucket is versioned: every object version and delete marker must go before the bucket can.
const deleteBucket = async (Bucket) => {
  for (;;) {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket }));
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({ Key, VersionId }));
    if (objects.length === 0) break;
    await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects } }));
  }
  await s3.send(new DeleteBucketCommand({ Bucket }));
};

try {
  const state = readState();
  if (state === undefined) {
    log('Nothing to clean up.');
    process.exit(0);
  }

  if (await localstackUp()) {
    const { stackName } = state;
    log(`Deleting stack ${stackName} and its bucket`);
    // The template retains the bucket on stack deletion, so it goes explicitly (found by its name prefix).
    const prefix = `${stackName.toLowerCase()}-snapshotbucket`;
    const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
    for (const { Name } of Buckets.filter(({ Name }) => Name?.startsWith(prefix))) await deleteBucket(Name);
    const cfn = new CloudFormationClient({});
    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    try {
      await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 120 }, { StackName: stackName });
    } catch (error) {
      // LocalStack answers "does not exist" once the stack is gone, which the waiter reports as a failure.
      if (!JSON.stringify(error).includes('does not exist')) throw error;
    }
    if (state.startedLocalStack) {
      log('Stopping LocalStack');
      execFileSync('docker', [...COMPOSE, 'down'], { stdio: 'inherit' });
    }
  } else {
    log('LocalStack is not running, so its resources are already gone.');
  }
  clearState();
  log('Done.');
} catch (error) {
  fail(error);
}
