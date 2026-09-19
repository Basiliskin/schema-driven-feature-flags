import type { NotifyErrorHandler } from '@featuresync/aws';
import { describe, expect, it, vi } from 'vitest';
import { editFeature, type EditFeaturePorts } from '../../src/application/edit-feature.js';
import {
  DEFAULT_NOT_EDITABLE_MESSAGE,
  EDIT_CONFLICT,
  EDITED_SNAPSHOT_INVALID_MESSAGE,
  FEATURE_EXISTS_MESSAGE,
  FETCH_ERROR_MESSAGES,
  INVALID_DEFAULT_JSON_MESSAGE,
  INVALID_KEY_MESSAGE,
  INVALID_RULES_JSON_MESSAGE,
  NOTIFY_FAILED_WARNING,
  PUBLISH_ERROR_MESSAGES,
  UNEXPECTED_ERROR_MESSAGE,
  UNKNOWN_FEATURE_MESSAGE,
} from '../../src/application/error-messages.js';
import type { SnapshotWriter } from '../../src/application/publish-snapshot.js';
import type { FlagEdit } from '../../src/domain/flag-edit.js';


const baseSnapshot = {
  schemaVersion: 1,
  environment: 'production',
  version: 4,
  createdAt: '2026-09-19T06:00:00.000Z',
  createdBy: 'ci',
  previousVersion: 3,
  reason: 'seed',
  features: {
    'dark-mode': { type: 'boolean', enabled: false },
    'checkout-limits': { type: 'config', enabled: true, default: { max: 3 } },
  },
};

const awsError = (name: string, reason: string) => Object.assign(new Error(reason), { name, reason });

type PublishBehaviour = (onNotifyError: NotifyErrorHandler) => Promise<number>;

interface FakeOptions {
  readonly fetch?: () => Promise<string>;
  readonly publish?: PublishBehaviour;
  readonly pointer?: () => Promise<number | undefined>;
}

const fakePorts = (options: FakeOptions = {}) => {
  const calls: string[] = [];
  const writer = {
    publish: vi.fn<SnapshotWriter['publish']>(),
    rollback: vi.fn<SnapshotWriter['rollback']>(),
  };
  const fetchSnapshotText = vi.fn<EditFeaturePorts['fetchSnapshotText']>(() => {
    calls.push('fetch');
    return options.fetch?.() ?? Promise.resolve(JSON.stringify(baseSnapshot));
  });
  const readCurrentVersion = vi.fn<EditFeaturePorts['readCurrentVersion']>(() => {
    calls.push('pointer');
    return options.pointer?.() ?? Promise.resolve(4);
  });
  const ports: EditFeaturePorts = {
    fetchSnapshotText,
    readCurrentVersion,
    openWriter: (onNotifyError) => {
      writer.publish.mockImplementation(() => {
        calls.push('publish');
        return options.publish?.(onNotifyError) ?? Promise.resolve(5);
      });
      return writer;
    },
  };
  return { ports, writer, calls, fetchSnapshotText };
};

const toggleDarkMode: FlagEdit = {
  kind: 'enabled',
  key: 'dark-mode',
  enabled: true,
};

const rejectPublish =
  (reason: string): PublishBehaviour =>
  () =>
    Promise.reject(awsError('S3PublishError', reason));

describe('editFeature', () => {
  it('fetches the base version, publishes the edit with expectedCurrentVersion and never pre-reads the pointer', async () => {
    const { ports, writer, calls, fetchSnapshotText } = fakePorts();

    const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

    expect(outcome).toEqual({
      kind: 'success',
      version: 5,
      message: 'Published version 5 to production.',
    });
    expect(fetchSnapshotText).toHaveBeenCalledWith('production', 4);
    expect(calls).toEqual(['fetch', 'publish']);
    expect(writer.publish).toHaveBeenCalledTimes(1);
    const [environment, snapshot, options] = writer.publish.mock.calls[0] ?? [];
    expect(environment).toBe('production');
    expect(options).toEqual({ expectedCurrentVersion: 4 });
    expect(snapshot).toMatchObject({
      createdBy: 'dashboard',
      reason: 'Set dark-mode.enabled=true via dashboard',
      features: { 'dark-mode': { type: 'boolean', enabled: true } },
    });
  });

  it('describes a default edit in the generated reason', async () => {
    const { ports, writer } = fakePorts();

    await editFeature(ports, 'production', 4, {
      kind: 'default',
      key: 'checkout-limits',
      defaultJson: '{"max":5}',
    });

    expect(writer.publish.mock.calls[0]?.[1]).toMatchObject({
      reason: 'Set checkout-limits.default via dashboard',
      features: { 'checkout-limits': { default: { max: 5 } } },
    });
  });

  it.each<[string, FlagEdit, string, Record<string, unknown>]>([
    [
      'a created feature',
      { kind: 'create', key: 'beta', type: 'config', enabled: true, defaultJson: '1' },
      'Create config feature beta via dashboard',
      { beta: { type: 'config', enabled: true, default: 1 } },
    ],
    [
      'a deleted feature',
      { kind: 'delete', key: 'dark-mode' },
      'Delete feature dark-mode via dashboard',
      { 'checkout-limits': baseSnapshot.features['checkout-limits'] },
    ],
    [
      'replaced rules',
      { kind: 'setRules', key: 'dark-mode', rulesJson: '[{"when":{"plan":"pro"},"enabled":true}]' },
      'Set dark-mode.rules via dashboard',
      { 'dark-mode': { type: 'boolean', enabled: false, rules: [{ when: { plan: 'pro' }, enabled: true }] } },
    ],
  ])('publishes %s as one version against the base version', async (_, edit, reason, features) => {
    const { ports, writer } = fakePorts();

    const outcome = await editFeature(ports, 'production', 4, edit);

    expect(outcome).toMatchObject({ kind: 'success', message: 'Published version 5 to production.' });
    expect(writer.publish).toHaveBeenCalledTimes(1);
    const [environment, snapshot, options] = writer.publish.mock.calls[0] ?? [];
    expect(environment).toBe('production');
    expect(options).toEqual({ expectedCurrentVersion: 4 });
    expect(snapshot).toMatchObject({ reason, createdBy: 'dashboard', features });
  });

  it('keeps a failed change notification as a warning', async () => {
    const { ports } = fakePorts({
      publish: (onNotifyError) => {
        onNotifyError(new Error('sns down'), {
          environment: 'production',
          version: 5,
        });
        return Promise.resolve(5);
      },
    });

    const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

    expect(outcome).toEqual({
      kind: 'success',
      version: 5,
      message: 'Published version 5 to production.',
      warning: NOTIFY_FAILED_WARNING,
    });
  });

  describe('when the publish loses a race or hits a rolled-back version', () => {
    it('maps CONFLICT to EDIT_CONFLICT naming the version that is now current', async () => {
      const { ports, calls } = fakePorts({
        publish: rejectPublish('CONFLICT'),
        pointer: () => Promise.resolve(7),
      });

      const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

      expect(outcome).toEqual({
        kind: 'failure',
        message: EDIT_CONFLICT(7),
        issues: [],
      });
      expect(outcome.message).toBe('Someone else published version 7 meanwhile — reload and redo your edit.');
      expect(calls).toEqual(['fetch', 'publish', 'pointer']);
    });

    it('maps VERSION_EXISTS with a moved pointer to EDIT_CONFLICT', async () => {
      const { ports } = fakePorts({
        publish: rejectPublish('VERSION_EXISTS'),
        pointer: () => Promise.resolve(5),
      });

      const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

      expect(outcome).toEqual({
        kind: 'failure',
        message: EDIT_CONFLICT(5),
        issues: [],
      });
      expect(outcome.message).toContain('version 5 meanwhile');
    });

    it('maps VERSION_EXISTS to EDIT_CONFLICT, never to post-rollback guidance', async () => {
      const { ports } = fakePorts({
        publish: rejectPublish('VERSION_EXISTS'),
        pointer: () => Promise.resolve(4),
      });

      const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

      expect(outcome).toEqual({ kind: 'failure', message: EDIT_CONFLICT(4), issues: [] });
      expect(outcome.message).not.toContain('paste-publish');
    });

    it.each([
      ['CONFLICT', 'fails', () => Promise.reject(new Error('s3 down'))],
      ['VERSION_EXISTS', 'fails', () => Promise.reject(new Error('s3 down'))],
      ['CONFLICT', 'finds no pointer', () => Promise.resolve(undefined)],
    ])(
      'falls back to wording without a number when %s is followed by a re-read that %s',
      async (reason, _, pointer) => {
        const { ports } = fakePorts({
          publish: rejectPublish(reason),
          pointer,
        });

        const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

        expect(outcome).toEqual({
          kind: 'failure',
          message: EDIT_CONFLICT(),
          issues: [],
        });
        expect(outcome.message).toBe('Someone else published a new version meanwhile — reload and redo your edit.');
        expect(outcome.message).not.toMatch(/\d|undefined/);
      },
    );
  });

  it.each([
    'INVALID_ENVIRONMENT',
    'INVALID_POINTER',
    'INVALID_SNAPSHOT',
    'INVALID_ROLLBACK_TARGET',
    'REQUEST_FAILED',
  ] as const)('reports the %s publish error with its existing message and no pointer re-read', async (reason) => {
    const { ports, calls } = fakePorts({ publish: rejectPublish(reason) });

    const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

    expect(outcome).toMatchObject({
      kind: 'failure',
      message: PUBLISH_ERROR_MESSAGES[reason],
    });
    expect(calls).not.toContain('pointer');
  });

  it('reports an unexpected publish error without re-reading the pointer', async () => {
    const { ports, calls } = fakePorts({
      publish: () => Promise.reject(new Error('boom')),
    });

    const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

    expect(outcome).toEqual({
      kind: 'failure',
      message: UNEXPECTED_ERROR_MESSAGE,
      issues: [],
    });
    expect(calls).toEqual(['fetch', 'publish']);
  });

  it.each(Object.keys(FETCH_ERROR_MESSAGES) as (keyof typeof FETCH_ERROR_MESSAGES)[])(
    'reports the %s fetch error without publishing',
    async (reason) => {
      const { ports, writer } = fakePorts({
        fetch: () => Promise.reject(awsError('S3FetchError', reason)),
      });

      const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

      expect(outcome).toEqual({
        kind: 'failure',
        message: FETCH_ERROR_MESSAGES[reason],
        issues: [],
      });
      expect(writer.publish).not.toHaveBeenCalled();
    },
  );

  describe('reports a rejected edit without publishing', () => {
    it.each<[string, FlagEdit, string, readonly string[]]>([
      ['an unknown feature', { kind: 'enabled', key: 'nope', enabled: true }, UNKNOWN_FEATURE_MESSAGE('nope'), []],
      [
        'a default edit on a boolean feature',
        { kind: 'default', key: 'dark-mode', defaultJson: 'true' },
        DEFAULT_NOT_EDITABLE_MESSAGE('dark-mode'),
        [],
      ],
      [
        'a duplicate key',
        { kind: 'create', key: 'dark-mode', type: 'boolean', enabled: true },
        FEATURE_EXISTS_MESSAGE('dark-mode'),
        [],
      ],
      [
        'an invalid key',
        { kind: 'create', key: 'bad/key', type: 'boolean', enabled: true },
        INVALID_KEY_MESSAGE('bad/key'),
        [],
      ],
      ['a delete of an unknown feature', { kind: 'delete', key: 'nope' }, UNKNOWN_FEATURE_MESSAGE('nope'), []],
    ])('%s', async (_, edit, message, issues) => {
      const { ports, writer } = fakePorts();

      const outcome = await editFeature(ports, 'production', 4, edit);

      expect(outcome).toEqual({ kind: 'failure', message, issues });
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('an unparseable default, with the parser message as the issue', async () => {
      const { ports, writer } = fakePorts();

      const outcome = await editFeature(ports, 'production', 4, {
        kind: 'default',
        key: 'checkout-limits',
        defaultJson: '{max',
      });

      expect(outcome).toMatchObject({
        kind: 'failure',
        message: INVALID_DEFAULT_JSON_MESSAGE,
      });
      expect(outcome.kind === 'failure' && outcome.issues).toHaveLength(1);
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('unparseable rules, with the parser message as the issue', async () => {
      const { ports, writer } = fakePorts();

      const outcome = await editFeature(ports, 'production', 4, { kind: 'setRules', key: 'dark-mode', rulesJson: '[' });

      expect(outcome).toMatchObject({ kind: 'failure', message: INVALID_RULES_JSON_MESSAGE });
      expect(outcome.kind === 'failure' && outcome.issues).toHaveLength(1);
      expect(writer.publish).not.toHaveBeenCalled();
    });

    it('an edit that leaves the snapshot invalid, as path: message lines', async () => {
      const { ports, writer } = fakePorts({
        fetch: () => Promise.resolve(JSON.stringify({ ...baseSnapshot, unexpected: true })),
      });

      const outcome = await editFeature(ports, 'production', 4, toggleDarkMode);

      expect(outcome).toMatchObject({
        kind: 'failure',
        message: EDITED_SNAPSHOT_INVALID_MESSAGE,
      });
      expect(outcome.kind === 'failure' && outcome.issues[0]).toMatch(/: /);
      expect(writer.publish).not.toHaveBeenCalled();
    });
  });
});
