// Shared by setup.js, run.js and cleanup.js: LocalStack-pinned AWS clients and the sandbox state file.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const LOCALSTACK = 'http://localhost:4566';
export const ENVIRONMENT = 'dev';
export const COMPOSE = ['compose', '-f', `${ROOT}docker/docker-compose.yml`];
const STATE_FILE = fileURLToPath(new URL('.dev-state.json', import.meta.url));

// Pin every AWS client to LocalStack so nothing can reach real AWS, whatever .env says.
Object.assign(process.env, {
  AWS_ENDPOINT_URL_S3: 'http://s3.localhost.localstack.cloud:4566',
  AWS_ENDPOINT_URL_SNS: LOCALSTACK,
  AWS_ENDPOINT_URL_SQS: LOCALSTACK,
  AWS_ENDPOINT_URL_CLOUDFORMATION: LOCALSTACK,
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
});

export const log = (line) => console.log(`[dev] ${line}`);

export const localstackUp = async () => {
  try {
    return (await fetch(`${LOCALSTACK}/_localstack/health`)).ok;
  } catch {
    return false;
  }
};

/** @returns {{stackName: string, bucket?: string, topicArn?: string, queueUrl?: string, startedLocalStack: boolean} | undefined} */
export const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : undefined);
export const writeState = (state) => writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
export const clearState = () => rmSync(STATE_FILE, { force: true });

export const fail = (error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : JSON.stringify(error)}`);
  process.exit(1);
};
