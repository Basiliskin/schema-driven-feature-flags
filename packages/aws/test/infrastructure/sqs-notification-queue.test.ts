import { DeleteMessageCommand, ReceiveMessageCommand, type Message, type SQSClient } from '@aws-sdk/client-sqs';
import type { Logger } from '@featuresync/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeNotification } from '../../src/domain/change-notification.js';
import { createSqsNotificationQueue } from '../../src/infrastructure/sqs-notification-queue.js';

const { constructedWith } = vi.hoisted(() => ({ constructedWith: [] as unknown[] }));

vi.mock('@aws-sdk/client-sqs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sqs')>();
  class SQSClient {
    constructor(config: unknown) {
      constructedWith.push(config);
    }
    send(_command: unknown, options: { abortSignal: AbortSignal }) {
      return new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    }
  }
  return { ...actual, SQSClient };
});

const queueUrl = 'https://sqs.eu-west-1.amazonaws.com/123456789012/app-notifications';

const notification = (version: number): ChangeNotification => ({
  schemaVersion: 1,
  environment: 'production',
  version,
  snapshotKey: `production/snapshots/${String(version)}.json`,
});

const raw = (version: number, receipt: string): Message => ({
  Body: JSON.stringify(notification(version)),
  ReceiptHandle: receipt,
});

const wrapped = (version: number, receipt: string): Message => ({
  Body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify(notification(version)) }),
  ReceiptHandle: receipt,
});

type Receive = Message[] | undefined | Error;

/** Answers each receive with the next scripted batch; once the script runs out, waits until aborted. */
const fakeSqs = (receives: Receive[], deleteError?: Error) => {
  const deleted: (string | undefined)[] = [];
  const receiveInputs: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  const send = vi.fn((command: ReceiveMessageCommand | DeleteMessageCommand, options?: { abortSignal?: AbortSignal }) => {
    if (command instanceof DeleteMessageCommand) {
      if (deleteError !== undefined) return Promise.reject(deleteError);
      expect(command.input.QueueUrl).toBe(queueUrl);
      deleted.push(command.input.ReceiptHandle);
      return Promise.resolve({});
    }
    receiveInputs.push({ ...command.input });
    const signal = options?.abortSignal;
    if (signal === undefined) throw new Error('receive must be abortable');
    signals.push(signal);
    if (receives.length === 0) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
        });
      });
    }
    const next = receives.shift();
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ Messages: next });
  });
  return { client: { send } as unknown as Pick<SQSClient, 'send'>, deleted, receiveInputs, signals, send };
};

const recordingLogger = () => {
  const errors: string[] = [];
  const logger: Logger = {
    error: (message) => {
      errors.push(message);
    },
  };
  return { logger, errors };
};

const idleAfter = async (sqs: ReturnType<typeof fakeSqs>, receives: number) => {
  await vi.waitFor(() => {
    expect(sqs.receiveInputs).toHaveLength(receives);
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe('createSqsNotificationQueue', () => {
  it('long-polls the queue and hands raw and SNS-wrapped notifications to the handler, deleting each after', async () => {
    const sqs = fakeSqs([[raw(4, 'r-4'), wrapped(5, 'r-5')]]);
    const received: ChangeNotification[] = [];
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client }).start((value) => {
      received.push(value);
      return Promise.resolve();
    });

    await idleAfter(sqs, 2);
    stop();

    expect(received).toEqual([notification(4), notification(5)]);
    expect(sqs.deleted).toEqual(['r-4', 'r-5']);
    expect(sqs.receiveInputs[0]).toEqual({ QueueUrl: queueUrl, WaitTimeSeconds: 20, MaxNumberOfMessages: 10 });
  });

  it('uses the configured long-poll wait and keeps polling after an empty receive', async () => {
    const sqs = fakeSqs([undefined, []]);
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client, waitTimeSeconds: 5 }).start(() =>
      Promise.resolve(),
    );

    await idleAfter(sqs, 3);
    stop();

    expect(sqs.receiveInputs.map((input) => input.WaitTimeSeconds)).toEqual([5, 5, 5]);
  });

  it('logs and deletes a message that is not a Change Notification', async () => {
    const sqs = fakeSqs([[{ Body: '{"hello":"world"}', ReceiptHandle: 'poison' }, { ReceiptHandle: 'empty' }]]);
    const { logger, errors } = recordingLogger();
    const handler = vi.fn(() => Promise.resolve());
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client, logger }).start(handler);

    await idleAfter(sqs, 2);
    stop();

    expect(handler).not.toHaveBeenCalled();
    expect(sqs.deleted).toEqual(['poison', 'empty']);
    expect(errors).toEqual([
      'Discarding an unreadable message from the SQS notification queue',
      'Discarding an unreadable message from the SQS notification queue',
    ]);
  });

  it('leaves a message undeleted when the handler fails, so SQS redelivers it', async () => {
    const sqs = fakeSqs([[raw(4, 'r-4'), raw(5, 'r-5')]]);
    const { logger, errors } = recordingLogger();
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client, logger }).start((value) =>
      value.version === 4 ? Promise.reject(new Error('reload failed')) : Promise.resolve(),
    );

    await idleAfter(sqs, 2);
    stop();

    expect(sqs.deleted).toEqual(['r-5']);
    expect(errors).toEqual(['Change notification handler failed; leaving the message for redelivery']);
  });

  it('logs a failed delete and keeps polling', async () => {
    const sqs = fakeSqs([[raw(4, 'r-4')]], new Error('access denied'));
    const { logger, errors } = recordingLogger();
    const handler = vi.fn(() => Promise.resolve());
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client, logger }).start(handler);

    await idleAfter(sqs, 2);
    stop();

    expect(handler).toHaveBeenCalledOnce();
    expect(errors).toEqual(['Cannot delete a message from the SQS notification queue']);
  });

  it('logs a receive error and retries only after the backoff', async () => {
    vi.useFakeTimers();
    const sqs = fakeSqs([new Error('throttled')]);
    const { logger, errors } = recordingLogger();
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client, logger }).start(() => Promise.resolve());

    await vi.advanceTimersByTimeAsync(999);
    expect(sqs.receiveInputs).toHaveLength(1);
    expect(errors).toEqual(['Cannot receive from the SQS notification queue; retrying']);

    await vi.advanceTimersByTimeAsync(1);
    expect(sqs.receiveInputs).toHaveLength(2);
    stop();
  });

  it('stops during the retry backoff without receiving again', async () => {
    vi.useFakeTimers();
    const sqs = fakeSqs([new Error('throttled')]);
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client, logger: recordingLogger().logger }).start(
      () => Promise.resolve(),
    );

    await vi.advanceTimersByTimeAsync(500);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sqs.receiveInputs).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts the in-flight receive on stop and ends quietly', async () => {
    const sqs = fakeSqs([]);
    const { logger, errors } = recordingLogger();
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client, logger }).start(() => Promise.resolve());

    await idleAfter(sqs, 1);
    stop();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sqs.signals[0]?.aborted).toBe(true);
    expect(sqs.receiveInputs).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('stops handing over a received batch once stopped', async () => {
    const sqs = fakeSqs([[raw(4, 'r-4'), raw(5, 'r-5')]]);
    const received: number[] = [];
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client }).start((value) => {
      received.push(value.version);
      stop();
      return Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(sqs.deleted).toEqual(['r-4']);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toEqual([4]);
    expect(sqs.receiveInputs).toHaveLength(1);
  });

  it('builds one default client from the standard AWS SDK configuration on first start', async () => {
    constructedWith.length = 0;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const queue = createSqsNotificationQueue({ queueUrl });
    expect(constructedWith).toEqual([]);

    const stop = queue.start(() => Promise.resolve());
    await vi.waitFor(() => {
      expect(constructedWith).toEqual([{}]);
    });
    stop();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('logs to the console by default', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sqs = fakeSqs([[{ Body: 'nope', ReceiptHandle: 'x' }]]);
    const stop = createSqsNotificationQueue({ queueUrl, client: sqs.client }).start(() => Promise.resolve());

    await idleAfter(sqs, 2);
    stop();

    expect(consoleError).toHaveBeenCalledWith(
      '[featuresync] Discarding an unreadable message from the SQS notification queue',
      expect.objectContaining({ reason: 'INVALID_JSON' }),
    );
    consoleError.mockRestore();
  });
});
