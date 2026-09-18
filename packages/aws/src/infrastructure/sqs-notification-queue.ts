import type { Message, SQSClient } from '@aws-sdk/client-sqs';
import type { Logger } from '@featuresync/core';
import { parseChangeNotification, type ChangeNotification } from '../domain/change-notification.js';

const DEFAULT_WAIT_TIME_SECONDS = 20;
const RETRY_DELAY_MS = 1_000;

/** Options for {@link createSqsNotificationQueue}. */
export interface SqsNotificationQueueOptions {
  readonly queueUrl: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<SQSClient, 'send'>;
  /** Long-poll duration of each receive, 0–20 seconds. Defaults to 20. */
  readonly waitTimeSeconds?: number;
  readonly logger?: Logger;
}

export type NotificationHandler = (notification: ChangeNotification) => Promise<void>;

export interface NotificationQueue {
  /** Starts receiving; the returned function stops it, aborting any receive in flight. */
  start(onNotification: NotificationHandler): () => void;
}

const consoleLogger: Logger = {
  error: (message, error) => {
    console.error(`[featuresync] ${message}`, error);
  },
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** Long-polls an SQS queue subscribed to the change topic and hands each Change Notification to a handler. */
export function createSqsNotificationQueue(options: SqsNotificationQueueOptions): NotificationQueue {
  const { queueUrl } = options;
  const waitTimeSeconds = options.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS;
  const logger = options.logger ?? consoleLogger;
  let client = options.client;

  // Imported on first use: @aws-sdk/client-sqs is an optional peer and this module is reachable from the package index.
  const sdk = async () => {
    const module = await import('@aws-sdk/client-sqs');
    client ??= new module.SQSClient({});
    return { module, client };
  };

  const deleteMessage = async (message: Message): Promise<void> => {
    try {
      const { module, client: sqs } = await sdk();
      await sqs.send(new module.DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      logger.error('Cannot delete a message from the SQS notification queue', error);
    }
  };

  const handle = async (message: Message, onNotification: NotificationHandler): Promise<void> => {
    const parsed = parseChangeNotification(message.Body ?? '');
    if (!parsed.ok) {
      logger.error('Discarding an unreadable message from the SQS notification queue', parsed.error);
      await deleteMessage(message);
      return;
    }
    try {
      await onNotification(parsed.value);
    } catch (error) {
      logger.error('Change notification handler failed; leaving the message for redelivery', error);
      return;
    }
    await deleteMessage(message);
  };

  const run = async (signal: AbortSignal, onNotification: NotificationHandler): Promise<void> => {
    const stopped = () => signal.aborted;
    while (!stopped()) {
      let messages: Message[];
      try {
        const { module, client: sqs } = await sdk();
        const received = await sqs.send(
          new module.ReceiveMessageCommand({
            QueueUrl: queueUrl,
            WaitTimeSeconds: waitTimeSeconds,
            MaxNumberOfMessages: 10,
          }),
          { abortSignal: signal },
        );
        messages = received.Messages ?? [];
      } catch (error) {
        if (stopped()) return;
        logger.error('Cannot receive from the SQS notification queue; retrying', error);
        await sleep(RETRY_DELAY_MS, signal);
        continue;
      }
      for (const message of messages) {
        if (stopped()) return;
        await handle(message, onNotification);
      }
    }
  };

  return {
    start(onNotification) {
      const controller = new AbortController();
      void run(controller.signal, onNotification);
      return () => {
        controller.abort();
      };
    },
  };
}
