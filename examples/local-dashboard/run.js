// Step 2 of 3 (`pnpm dev:run`): serve the dashboard over the sandbox from `pnpm dev:setup`, plus a live
// SDK reader. Ctrl-C stops only these; the sandbox stays until `pnpm dev:cleanup`, so you can run again.
import { ENVIRONMENT, fail, localstackUp, log, readState } from './common.js';

const { createFeatureFlags } = await import('@featuresync/core');
const { createS3SnapshotSource, createSqsNotificationQueue } = await import('@featuresync/aws');
const { createAwsDashboardPorts } = await import('@featuresync/dashboard/dist/infrastructure/aws-adapters.js');
const { startDashboardServer } = await import('@featuresync/dashboard/dist/infrastructure/http-server.js');

const PORT = Number(process.env.PORT ?? 4455);

try {
  const state = readState();
  if (state?.bucket === undefined) throw new Error('No sandbox found. Run `pnpm dev:setup` first.');
  if (!(await localstackUp())) throw new Error('LocalStack is not running. Run `pnpm dev:cleanup`, then `pnpm dev:setup`.');

  const dashboard = await startDashboardServer({
    ports: createAwsDashboardPorts({ bucket: state.bucket, topicArn: state.topicArn }),
    port: PORT,
  }).catch((error) => {
    if (error?.code !== 'EADDRINUSE') throw error;
    throw new Error(`Port ${String(PORT)} is busy (another dashboard?). Stop it or run: PORT=4460 pnpm dev:run`);
  });

  const flags = createFeatureFlags({
    source: createS3SnapshotSource({
      bucket: state.bucket,
      environment: ENVIRONMENT,
      notificationQueue: createSqsNotificationQueue({ queueUrl: state.queueUrl, waitTimeSeconds: 5 }),
    }),
  });
  await flags.ready();
  let last;
  const report = () => {
    const payment = flags.evaluate('payment-flow', { plan: 'free' }).value;
    const line = `v${String(flags.version())}  new-dashboard(employee/customer)=${String(flags.isEnabled('new-dashboard', { isEmployee: true }))}/${String(flags.isEnabled('new-dashboard', { isEmployee: false }))}  payment-flow=${JSON.stringify(payment)}`;
    if (line !== last) log(`app sees → ${line}`);
    last = line;
  };
  report();
  const timer = setInterval(report, 500);

  const stop = async () => {
    clearInterval(timer);
    flags.close();
    await dashboard.close();
    log('Dashboard stopped. The sandbox is still up: `pnpm dev:run` again, or `pnpm dev:cleanup` to remove it.');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  log('');
  log(`Dashboard:  ${dashboard.url}/env/${ENVIRONMENT}`);
  log(`Bucket:     ${state.bucket}`);
  log('Publish, roll back or edit flags in the browser; "app sees →" lines show an SDK client picking them up.');
  log('Press Ctrl-C to stop the dashboard.');
} catch (error) {
  fail(error);
}
