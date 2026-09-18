import type { FeatureDefinition } from '../domain/define-feature.js';
import { createFeatureFlags, type FeatureFlags } from '../application/flag-client.js';
import type { Logger } from '../application/logger.port.js';
import { createFileSnapshotSource } from './file-snapshot-source.js';

/** The environment does not say where snapshots come from. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

/** Options for {@link createFeatureFlagsFromEnv}. */
export interface FeatureFlagsFromEnvOptions<Defs extends readonly FeatureDefinition[]> {
  readonly definitions?: Defs;
  readonly logger?: Logger;
  /** Reload the snapshot file when it changes. */
  readonly watch?: boolean;
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Creates a flag client from `FEATURESYNC_FILE`, the path of a local snapshot JSON file.
 * Throws {@link ConfigurationError} when the variable is missing or empty.
 */
export function createFeatureFlagsFromEnv<const Defs extends readonly FeatureDefinition[] = []>(
  options: FeatureFlagsFromEnvOptions<Defs> = {},
): FeatureFlags<Defs> {
  const env = options.env ?? process.env;
  const path = env['FEATURESYNC_FILE'];
  if (path === undefined || path === '') {
    throw new ConfigurationError('Set FEATURESYNC_FILE to the path of a snapshot JSON file');
  }
  const { definitions, logger } = options;
  return createFeatureFlags<Defs>({
    source: createFileSnapshotSource({ path, watch: options.watch ?? false, ...(logger && { logger }) }),
    ...(definitions && { definitions }),
    ...(logger && { logger }),
  });
}
