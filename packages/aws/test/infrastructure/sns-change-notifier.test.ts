import { PublishCommand } from '@aws-sdk/client-sns';
import { describe, expect, it, vi } from 'vitest';
import { createSnsChangeNotifier } from '../../src/infrastructure/sns-change-notifier.js';

const { constructedWith, defaultSend } = vi.hoisted(() => ({
  constructedWith: [] as unknown[],
  defaultSend: vi.fn(() => Promise.resolve({})),
}));

vi.mock('@aws-sdk/client-sns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sns')>();
  class SNSClient {
    constructor(config: unknown) {
      constructedWith.push(config);
    }
    send = defaultSend;
  }
  return { ...actual, SNSClient };
});

const topicArn = 'arn:aws:sns:eu-west-1:123456789012:featuresync-updates';

describe('createSnsChangeNotifier', () => {
  it('publishes the Change Notification for the version to the topic', async () => {
    const send = vi.fn<(command: PublishCommand) => Promise<object>>(() => Promise.resolve({}));
    const notify = createSnsChangeNotifier({ topicArn, client: { send } });

    await notify('production', 43);

    expect(send).toHaveBeenCalledOnce();
    const [command] = send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(PublishCommand);
    expect(command?.input.TopicArn).toBe(topicArn);
    expect(JSON.parse(command?.input.Message ?? '')).toEqual({
      schemaVersion: 1,
      environment: 'production',
      version: 43,
      snapshotKey: 'production/snapshots/43.json',
    });
  });

  it('builds one default client from the standard AWS SDK configuration, on first send', async () => {
    constructedWith.length = 0;
    const notify = createSnsChangeNotifier({ topicArn });
    expect(constructedWith).toEqual([]);

    await notify('production', 1);
    await notify('production', 2);

    expect(constructedWith).toEqual([{}]);
    expect(defaultSend).toHaveBeenCalledTimes(2);
  });

  it('rejects when SNS rejects', async () => {
    const send = () => Promise.reject(new Error('throttled'));
    const notify = createSnsChangeNotifier({ topicArn, client: { send } });

    await expect(notify('production', 1)).rejects.toThrow('throttled');
  });
});
