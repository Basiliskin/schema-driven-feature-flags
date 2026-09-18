import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { consoleLogger, type Logger } from '../application/logger.port.js';
import type { SnapshotSource, Unsubscribe } from '../application/snapshot-source.port.js';

/** Why a snapshot file could not be turned into a raw snapshot. */
export type SnapshotFileErrorReason = 'READ_FAILED' | 'INVALID_JSON';

/** A snapshot file that could not be read or is not valid JSON. `cause` holds the underlying error. */
export class SnapshotFileError extends Error {
  override readonly name = 'SnapshotFileError';

  constructor(
    readonly reason: SnapshotFileErrorReason,
    readonly path: string,
    cause: unknown,
  ) {
    super(
      reason === 'READ_FAILED' ? `Cannot read snapshot file ${path}` : `Snapshot file ${path} is not valid JSON`,
      { cause },
    );
  }
}

/** Options for {@link createFileSnapshotSource}. */
export interface FileSnapshotSourceOptions {
  readonly path: string;
  /** Reloads the file when it changes and pushes the new snapshot to subscribers. */
  readonly watch?: boolean;
  /** Quiet period after the last change before reloading; editors often write a file in several steps. */
  readonly debounceMs?: number;
  /** Receives unreadable or malformed files seen while watching. Defaults to `console.error`. */
  readonly logger?: Logger;
}

const DEFAULT_DEBOUNCE_MS = 100;

/** A {@link SnapshotSource} that reads a snapshot from a local JSON file. */
export function createFileSnapshotSource(options: FileSnapshotSourceOptions): SnapshotSource {
  const { path } = options;
  const logger = options.logger ?? consoleLogger;

  const readText = async (): Promise<string> => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      throw new SnapshotFileError('READ_FAILED', path, error);
    }
  };

  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new SnapshotFileError('INVALID_JSON', path, error);
    }
  };

  const load = async (): Promise<unknown> => parse(await readText());

  if (options.watch !== true) return { load };

  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const subscribe = (onChange: (snapshot: unknown) => void): Unsubscribe => {
    let lastDelivered: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const report = (error: unknown) => {
      logger.error('Ignoring snapshot file change; keeping the active snapshot', error);
    };

    const reload = async () => {
      const text = await readText();
      if (text === lastDelivered) return;
      const snapshot = parse(text);
      lastDelivered = text;
      onChange(snapshot);
    };

    // The directory is watched, not the file: atomic saves replace the file's inode, which ends a file watch.
    const watcher = watch(dirname(path), { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        reload().catch(report);
      }, debounceMs);
    });
    watcher.on('error', report);

    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  };

  return { load, subscribe };
}
