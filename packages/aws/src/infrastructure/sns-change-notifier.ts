import type { SNSClient } from '@aws-sdk/client-sns';
import { buildChangeNotification } from '../domain/change-notification.js';

export interface SnsChangeNotifierOptions {
  readonly topicArn: string;
  /** Defaults to a client configured only from the standard AWS SDK environment and shared config. */
  readonly client?: Pick<SNSClient, 'send'> | undefined;
}

export type ChangeNotifier = (environment: string, version: number) => Promise<void>;

/** Publishes one Change Notification per call to an SNS topic. */
export function createSnsChangeNotifier(options: SnsChangeNotifierOptions): ChangeNotifier {
  let client = options.client;

  return async (environment, version) => {
    // Imported on first send: @aws-sdk/client-sns is an optional peer and this module is reachable from the package index.
    const { PublishCommand, SNSClient } = await import('@aws-sdk/client-sns');
    client ??= new SNSClient({});
    await client.send(
      new PublishCommand({ TopicArn: options.topicArn, Message: buildChangeNotification(environment, version) }),
    );
  };
}
