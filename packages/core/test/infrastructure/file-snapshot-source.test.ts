import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validSnapshot } from '../domain/fixtures.js';
import type { Logger } from '../../src/application/logger.port.js';
import type { Unsubscribe } from '../../src/application/snapshot-source.port.js';
import { createFileSnapshotSource, SnapshotFileError } from '../../src/infrastructure/file-snapshot-source.js';

const DEBOUNCE_MS = 20;
const QUIET_MS = DEBOUNCE_MS * 5;
const settle = () => new Promise((resolve) => setTimeout(resolve, QUIET_MS));

let dir: string;
let path: string;
const unsubscribes: Unsubscribe[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'featuresync-source-'));
  path = join(dir, 'flags.json');
});

afterEach(async () => {
  unsubscribes.splice(0).forEach((unsubscribe) => {
    unsubscribe();
  });
  await rm(dir, { recursive: true, force: true });
});

const spyLogger = () => ({ error: vi.fn<Logger['error']>() });

const watching = (logger: Logger = spyLogger()) => {
  const source = createFileSnapshotSource({ path, watch: true, debounceMs: DEBOUNCE_MS, logger });
  const onChange = vi.fn<(snapshot: unknown) => void>();
  const unsubscribe = source.subscribe?.(onChange);
  if (unsubscribe === undefined) throw new Error('watch mode must support subscribe');
  unsubscribes.push(unsubscribe);
  return { onChange, unsubscribe };
};

const loadError = async (promise: Promise<unknown>): Promise<SnapshotFileError> => {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  if (!(error instanceof SnapshotFileError)) throw new Error('expected a SnapshotFileError');
  return error;
};

describe('createFileSnapshotSource', () => {
  describe('load', () => {
    it('reads and parses the JSON file', async () => {
      await writeFile(path, '{"version": 3}');

      await expect(createFileSnapshotSource({ path }).load()).resolves.toEqual({ version: 3 });
    });

    it('rejects with READ_FAILED when the file cannot be read', async () => {
      const error = await loadError(createFileSnapshotSource({ path }).load());

      expect(error.reason).toBe('READ_FAILED');
      expect(error.path).toBe(path);
      expect(error.message).toBe(`Cannot read snapshot file ${path}`);
      expect(error.cause).toMatchObject({ code: 'ENOENT' });
    });

    it('rejects with INVALID_JSON when the file is malformed', async () => {
      await writeFile(path, '{"version": ');

      const error = await loadError(createFileSnapshotSource({ path }).load());

      expect(error.reason).toBe('INVALID_JSON');
      expect(error.name).toBe('SnapshotFileError');
      expect(error.message).toBe(`Snapshot file ${path} is not valid JSON`);
      expect(error.cause).toBeInstanceOf(SyntaxError);
    });

    it('offers no subscription unless watching', () => {
      expect(createFileSnapshotSource({ path })).not.toHaveProperty('subscribe');
    });
  });

  describe('watch', () => {
    it('pushes the new snapshot once after a burst of writes', async () => {
      const { onChange } = watching();

      await writeFile(path, '{"version": 1}');
      await writeFile(path, '{"version": 2}');

      await vi.waitFor(() => {
        expect(onChange).toHaveBeenCalledWith({ version: 2 });
      });
      await settle();
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('follows editors that save by renaming a temp file over the snapshot', async () => {
      await writeFile(path, '{"version": 1}');
      const { onChange } = watching();

      await writeFile(join(dir, 'flags.json.tmp'), '{"version": 2}');
      await rename(join(dir, 'flags.json.tmp'), path);
      await vi.waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith({ version: 2 });
      });

      await writeFile(join(dir, 'flags.json.tmp'), '{"version": 3}');
      await rename(join(dir, 'flags.json.tmp'), path);
      await vi.waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith({ version: 3 });
      });
    });

    it('logs and skips truncated writes, then resumes on the next valid write', async () => {
      const logger = spyLogger();
      const { onChange } = watching(logger);

      await writeFile(path, '{"version": ');
      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          'Ignoring snapshot file change; keeping the active snapshot',
          expect.objectContaining({ reason: 'INVALID_JSON' }),
        );
      });
      expect(onChange).not.toHaveBeenCalled();

      await writeFile(path, '{"version": 2}');
      await vi.waitFor(() => {
        expect(onChange).toHaveBeenCalledWith({ version: 2 });
      });
    });

    it('logs and skips a snapshot file that disappears', async () => {
      await writeFile(path, '{"version": 1}');
      const logger = spyLogger();
      const { onChange } = watching(logger);

      await rm(path);

      await vi.waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ reason: 'READ_FAILED' }),
        );
      });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('ignores changes to other files in the directory', async () => {
      await writeFile(path, '{"version": 1}');
      const { onChange } = watching();
      await writeFile(join(dir, 'other.txt'), 'a');
      await vi.waitFor(() => {
        expect(onChange).toHaveBeenCalledTimes(1);
      });

      await writeFile(join(dir, 'other.txt'), 'b');
      await settle();

      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('stops watching, including a pending reload, once unsubscribed', async () => {
      const { onChange, unsubscribe } = watching();

      await writeFile(path, '{"version": 1}');
      unsubscribe();
      await writeFile(path, '{"version": 2}');
      await settle();

      expect(onChange).not.toHaveBeenCalled();
    });

    it('logs through console.error by default', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const source = createFileSnapshotSource({ path, watch: true });
      const unsubscribe = source.subscribe?.(() => undefined);
      if (unsubscribe) unsubscribes.push(unsubscribe);

      await writeFile(path, 'not json');

      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          '[featuresync] Ignoring snapshot file change; keeping the active snapshot',
          expect.any(SnapshotFileError),
        );
      });
      consoleError.mockRestore();
    });
  });

  describe('segments', () => {
    const snapshot = {
      ...validSnapshot(),
      schemaVersion: 2,
      features: {
        beta: {
          type: 'boolean',
          enabled: true,
          rules: [
            { when: { userId: { inSegment: 'beta-testers' } }, enabled: true },
            { when: { team: { inSegment: 'staff' } }, enabled: true },
          ],
        },
      },
    };
    const segmentFile = (key: string, version: number) => ({
      schemaVersion: 1,
      key,
      version,
      memberAttribute: 'userId',
      members: ['secret-member'],
    });

    const writeSegment = async (key: string, pointer: unknown, files: Record<string, string> = {}) => {
      const segmentDir = join(dir, 'segments', key);
      await mkdir(segmentDir, { recursive: true });
      await writeFile(join(segmentDir, 'current.json'), JSON.stringify(pointer));
      await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(segmentDir, name), content)));
    };

    const pointerTo = (key: string, version: number) => ({
      segmentKey: key,
      version,
      objectKey: `production/segments/${key}/${String(version)}.json`,
    });

    it('bundles each referenced segment the current pointer names', async () => {
      await writeFile(path, JSON.stringify(snapshot));
      await writeSegment('beta-testers', pointerTo('beta-testers', 2), {
        '1.json': JSON.stringify(segmentFile('beta-testers', 1)),
        '2.json': JSON.stringify(segmentFile('beta-testers', 2)),
      });
      await writeSegment('staff', pointerTo('staff', 1), {
        '1.json': JSON.stringify(segmentFile('staff', 1)),
      });

      await expect(createFileSnapshotSource({ path }).load()).resolves.toEqual({
        snapshot,
        segments: [segmentFile('beta-testers', 2), segmentFile('staff', 1)],
      });
    });

    it('leaves out segments that are missing, unreadable or badly pointed, and logs only their keys', async () => {
      const logger = spyLogger();
      await writeFile(path, JSON.stringify(snapshot));
      await writeSegment('beta-testers', pointerTo('other', 1), {
        '1.json': JSON.stringify(segmentFile('beta-testers', 1)),
      });

      await expect(createFileSnapshotSource({ path, logger }).load()).resolves.toEqual({ snapshot, segments: [] });
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(expect.any(String), new Error('Segment "staff"'));
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-member');
    });

    it('leaves out a segment whose version file is not valid JSON, without its content in the log', async () => {
      const logger = spyLogger();
      await writeFile(
        path,
        JSON.stringify({
          ...snapshot,
          features: {
            beta: {
              ...snapshot.features.beta,
              rules: [snapshot.features.beta.rules[0]],
            },
          },
        }),
      );
      await writeSegment('beta-testers', pointerTo('beta-testers', 1), {
        '1.json': 'secret-member,',
      });

      await expect(createFileSnapshotSource({ path, logger }).load()).resolves.toMatchObject({ segments: [] });
      expect(String(logger.error.mock.calls[0]?.[1])).not.toContain('secret-member');
    });

    it('rejects a null pointer', async () => {
      const logger = spyLogger();
      await writeFile(
        path,
        JSON.stringify({
          ...snapshot,
          features: {
            beta: {
              ...snapshot.features.beta,
              rules: [snapshot.features.beta.rules[0]],
            },
          },
        }),
      );
      await writeSegment('beta-testers', null);

      await expect(createFileSnapshotSource({ path, logger }).load()).resolves.toMatchObject({ segments: [] });
    });

    it('passes invalid snapshots and snapshots without segment references through unbundled', async () => {
      await writeFile(path, JSON.stringify(validSnapshot()));
      await expect(createFileSnapshotSource({ path }).load()).resolves.toEqual(validSnapshot());
    });

    it('pushes a bundle when watching', async () => {
      await writeSegment('beta-testers', pointerTo('beta-testers', 1), {
        '1.json': JSON.stringify(segmentFile('beta-testers', 1)),
      });
      const { onChange } = watching();

      await writeFile(path, JSON.stringify(snapshot));

      await vi.waitFor(() => {
        expect(onChange).toHaveBeenCalledWith({
          snapshot,
          segments: [segmentFile('beta-testers', 1)],
        });
      });
    });
  });
});
