import type { NotifyErrorHandler } from '@featuresync/aws';
import { describe, expect, it, vi } from 'vitest';
import {
  INVALID_JSON_MESSAGE,
  NOTIFY_FAILED_WARNING,
  PUBLISH_ERROR_MESSAGES,
} from '../../src/application/error-messages.js';
import {
  publishSnapshot,
  rollbackSnapshot,
  type SnapshotWriter,
  type ConflictPorts,
} from '../../src/application/publish-snapshot.js';

const SECRET = 'AKIAIOSFODNN7EXAMPLE';

const publishError = (reason: string, cause?: unknown) =>
  Object.assign(new Error(`${reason} for s3 object production/current.json`, { cause }), {
    name: 'S3PublishError',
    reason,
  });

type Behaviour = (onNotifyError: NotifyErrorHandler) => Promise<number>;

const fakePorts = (behaviour: Behaviour) => {
  const writer = { publish: vi.fn<SnapshotWriter['publish']>(), rollback: vi.fn<SnapshotWriter['rollback']>() };
  const ports: ConflictPorts = {
    readCurrentVersion: () => Promise.resolve(7),
    openWriter: (onNotifyError) => {
      writer.publish.mockImplementation(() => behaviour(onNotifyError));
      writer.rollback.mockImplementation(() => behaviour(onNotifyError));
      return writer;
    },
  };
  return { ports, writer };
};

const notifyThen =
  (version: number): Behaviour =>
  (onNotifyError) => {
    onNotifyError(new Error(`sns failed for ${SECRET}`), { environment: 'production', version });
    return Promise.resolve(version);
  };

describe('publishSnapshot', () => {
  it('publishes only on top of the version the draft started from', async () => {
    const { ports, writer } = fakePorts(() => Promise.resolve(4));

    await publishSnapshot(ports, 'production', '{}', 3);

    expect(writer.publish).toHaveBeenCalledWith('production', {}, { expectedCurrentVersion: 3 });
  });

  it.each(['CONFLICT', 'VERSION_EXISTS'])('reports %s against a base version as a reviewable conflict', async (reason) => {
    const { ports } = fakePorts(() => Promise.reject(publishError(reason)));

    await expect(publishSnapshot(ports, 'production', '{}', 3)).resolves.toEqual({
      kind: 'failure',
      message: 'Someone else published version 7 meanwhile, so your edit was not saved.',
      issues: [],
      conflict: { since: 3 },
    });
  });

  it('keeps the generic message for a conflict with no base version to review from', async () => {
    const { ports } = fakePorts(() => Promise.reject(publishError('CONFLICT')));

    const outcome = await publishSnapshot(ports, 'production', '{}');

    expect(outcome).toEqual({ kind: 'failure', message: PUBLISH_ERROR_MESSAGES.CONFLICT, issues: [] });
  });

  it('publishes the parsed snapshot once and reports the new version', async () => {
    const { ports, writer } = fakePorts(() => Promise.resolve(4));

    const outcome = await publishSnapshot(ports, 'production', '{"schemaVersion":1}');

    expect(outcome).toEqual({ kind: 'success', version: 4, message: 'Published version 4 to production.' });
    expect(writer.publish).toHaveBeenCalledTimes(1);
    expect(writer.publish).toHaveBeenCalledWith('production', { schemaVersion: 1 });
    expect(writer.rollback).not.toHaveBeenCalled();
  });

  it('rejects text that is not JSON without calling the publisher or echoing the input', async () => {
    const { ports, writer } = fakePorts(() => Promise.resolve(1));

    const outcome = await publishSnapshot(ports, 'production', `{"token": "${SECRET}"`);

    expect(outcome).toEqual({ kind: 'failure', message: INVALID_JSON_MESSAGE, issues: [] });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('reports snapshot validation issues as path: message lines', async () => {
    const cause = { issues: [{ path: 'features', message: 'required' }] };
    const { ports } = fakePorts(() => Promise.reject(publishError('INVALID_SNAPSHOT', cause)));

    const outcome = await publishSnapshot(ports, 'production', '{}');

    expect(outcome).toEqual({
      kind: 'failure',
      message: PUBLISH_ERROR_MESSAGES.INVALID_SNAPSHOT,
      issues: ['features: required'],
    });
  });

  it('keeps a failed change notification as a warning on a successful publish', async () => {
    const { ports } = fakePorts(notifyThen(2));

    const outcome = await publishSnapshot(ports, 'production', '{}');

    expect(outcome).toEqual({
      kind: 'success',
      version: 2,
      message: 'Published version 2 to production.',
      warning: NOTIFY_FAILED_WARNING,
    });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it('does not leak a notification warning into a concurrent request', async () => {
    let calls = 0;
    const { ports } = fakePorts((onNotifyError) => (++calls === 1 ? notifyThen(1)(onNotifyError) : Promise.resolve(2)));

    const [warned, clean] = await Promise.all([
      publishSnapshot(ports, 'production', '{}'),
      publishSnapshot(ports, 'production', '{}'),
    ]);

    expect(warned).toHaveProperty('warning', NOTIFY_FAILED_WARNING);
    expect(clean).not.toHaveProperty('warning');
  });
});

describe('rollbackSnapshot', () => {
  it('republishes the target once as a new version, authored by the dashboard', async () => {
    const { ports, writer } = fakePorts(() => Promise.resolve(5));

    const outcome = await rollbackSnapshot(ports, 'production', 2);

    expect(outcome).toEqual({ kind: 'success', version: 5, message: 'Restored version 2 of production as version 5.' });
    expect(writer.rollback).toHaveBeenCalledTimes(1);
    expect(writer.rollback).toHaveBeenCalledWith('production', 2, { actor: 'dashboard' });
    expect(writer.publish).not.toHaveBeenCalled();
  });

  it('keeps a failed change notification as a warning on a successful rollback', async () => {
    const { ports } = fakePorts(notifyThen(1));

    expect(await rollbackSnapshot(ports, 'production', 1)).toHaveProperty('warning', NOTIFY_FAILED_WARNING);
  });

  it('maps a failed rollback to its operator message without the raw cause', async () => {
    const { ports } = fakePorts(() => Promise.reject(publishError('CONFLICT', new Error(`request by ${SECRET}`))));

    const outcome = await rollbackSnapshot(ports, 'production', 1);

    expect(outcome).toEqual({ kind: 'failure', message: PUBLISH_ERROR_MESSAGES.CONFLICT, issues: [] });
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });
});
