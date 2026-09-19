import { parseArgs } from 'node:util';
import { createAwsDashboardPorts, type AwsDashboardConfig } from './infrastructure/aws-adapters.js';
import {
  startDashboardServer,
  type DashboardPorts,
  type DashboardServerOptions,
  type RunningDashboard,
} from './infrastructure/http-server.js';

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;

export type ExitCode = typeof EXIT_OK | typeof EXIT_FAILURE;

export const DEFAULT_PORT = 4455;

export interface DashboardIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly createPorts: (config: AwsDashboardConfig) => DashboardPorts;
  readonly startServer: (options: DashboardServerOptions) => Promise<RunningDashboard>;
}

export const nodeIo: DashboardIo = {
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  createPorts: createAwsDashboardPorts,
  startServer: startDashboardServer,
};

const USAGE = [
  'Usage:',
  '  featuresync-dashboard [--bucket <bucket>] [--topic-arn <arn>] [--port <port>]',
  'The bucket defaults to FEATURESYNC_BUCKET and the topic ARN to FEATURESYNC_TOPIC_ARN.',
  `The dashboard listens on 127.0.0.1, port ${String(DEFAULT_PORT)} by default (0 picks a free port).`,
].join('\n');

class UsageError extends Error {}

const parsePort = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) {
    throw new UsageError('--port must be an integer from 0 to 65535');
  }
  return Number(value);
};

const nonEmpty = (value: string | undefined): string | undefined => (value === '' ? undefined : value);

/** Starts the dashboard and resolves once it is listening; the open server keeps the process alive. */
export async function main(argv: readonly string[], io: DashboardIo = nodeIo): Promise<ExitCode> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        bucket: { type: 'string' },
        'topic-arn': { type: 'string' },
        port: { type: 'string' },
      },
    });
    const bucket = nonEmpty(values.bucket) ?? nonEmpty(io.env.FEATURESYNC_BUCKET);
    if (bucket === undefined) throw new UsageError('Missing --bucket or FEATURESYNC_BUCKET');
    const topicArn = nonEmpty(values['topic-arn']) ?? nonEmpty(io.env.FEATURESYNC_TOPIC_ARN);
    const port = parsePort(values.port);
    const ports = io.createPorts(topicArn === undefined ? { bucket } : { bucket, topicArn });
    const logError = (error: unknown): void => {
      io.err(String(error));
    };
    const dashboard = await io.startServer({ ports, port, logError });
    io.out(`FeatureSync dashboard for bucket ${bucket} at ${dashboard.url}`);
    return EXIT_OK;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError || (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      io.err(USAGE);
    }
    return EXIT_FAILURE;
  }
}
