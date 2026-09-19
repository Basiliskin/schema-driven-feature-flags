import type { ConfigOf, ContextOf, FeatureDefinition } from '../domain/define-feature.js';
import { evaluate, type EvaluationReason, type EvaluationResult, type Segments } from '../domain/evaluation/evaluate.js';
import { parseSegment } from '../domain/segment-contract.js';
import { parseSnapshot, referencedSegmentKeys, type Snapshot } from '../domain/snapshot.js';
import { StartupError } from './errors.js';
import { consoleLogger, type Logger } from './logger.port.js';
import { SnapshotStore, type ActiveSnapshot } from './snapshot-store.js';
import type { SnapshotSource, Unsubscribe } from './snapshot-source.port.js';

type Definitions = readonly FeatureDefinition[];
type KeyOf<Defs extends Definitions> = Defs[number]['key'];
type DefinitionFor<Defs extends Definitions, Key extends KeyOf<Defs>> = Extract<Defs[number], { key: Key }>;

/** Why a flag client answer has its value; `NOT_FOUND` means the key is absent from the active snapshot. */
export type FlagReason = EvaluationReason | 'NOT_FOUND';

/** The outcome of {@link FeatureFlags.evaluate}. */
export interface FlagEvaluation<Value> extends Omit<EvaluationResult<Value>, 'reason'> {
  readonly reason: FlagReason;
}

/** Features of the active snapshot, keyed by feature key. */
export type SnapshotFeatures = Snapshot['features'];

/** Options for {@link createFeatureFlags}. */
export type FeatureFlagsOptions<Defs extends Definitions> = {
  readonly source: SnapshotSource;
  /** Typed config features; snapshots whose values violate these schemas are rejected. */
  readonly definitions?: Defs;
  /** Defaults to logging through `console.error`. */
  readonly logger?: Logger;
} & (
  | { readonly allowStaleStartup?: false }
  | {
      /** Lets `ready()` resolve with `fallbackSnapshot` when the source fails at startup. */
      readonly allowStaleStartup: true;
      readonly fallbackSnapshot: unknown;
    }
);

/**
 * The in-memory flag client. Queries are synchronous, never touch the source and never throw;
 * snapshots are validated first and swapped whole, so a failed refresh keeps the previous one.
 */
export interface FeatureFlags<Defs extends Definitions = Definitions> {
  /** Whether the feature is on for the context; `false` when the key is unknown. */
  isEnabled(key: string, context?: unknown): boolean;
  /** The config value without targeting context; the definition default when the key is unknown. */
  get<Key extends KeyOf<Defs>>(key: Key): ConfigOf<DefinitionFor<Defs, Key>>;
  /** Evaluates the config's rules against a context validated by the definition's context schema. */
  evaluate<Key extends KeyOf<Defs>>(
    key: Key,
    context: ContextOf<DefinitionFor<Defs, Key>>,
  ): FlagEvaluation<ConfigOf<DefinitionFor<Defs, Key>>>;
  /** The active snapshot version, or `undefined` before one is loaded. */
  version(): number | undefined;
  has(key: string): boolean;
  getAll(): SnapshotFeatures;
  /** Resolves once a valid snapshot is active; rejects with {@link StartupError} otherwise. */
  ready(): Promise<void>;
  /** Loads from the source; resolves `true` if the loaded snapshot became active. */
  refresh(): Promise<boolean>;
  /** Stops listening to the source's change notifications. */
  close(): void;
}

const NO_FEATURES: SnapshotFeatures = Object.freeze({});

const isBundle = (raw: unknown): raw is { snapshot: unknown; segments: unknown } =>
  typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'snapshot');

/** Creates a {@link FeatureFlags} client and starts loading the first snapshot. */
export function createFeatureFlags<const Defs extends Definitions = []>(
  options: FeatureFlagsOptions<Defs>,
): FeatureFlags<Defs> {
  const { source } = options;
  const definitions: Definitions = options.definitions ?? [];
  const logger = options.logger ?? consoleLogger;
  const store = new SnapshotStore();
  const definitionsByKey = new Map(definitions.map((definition) => [definition.key, definition]));

  let lastFailure: unknown;

  const resolveSegments = (snapshot: Snapshot, rawSegments: readonly unknown[]): Segments => {
    const referenced = referencedSegmentKeys(snapshot);
    const resolved = new Map<string, ReadonlySet<string>>();
    for (const raw of rawSegments) {
      const parsed = parseSegment(raw);
      if (!parsed.ok) {
        logger.error('Rejected invalid segment; treating it as missing', parsed.error);
        continue;
      }
      if (referenced.has(parsed.value.key)) resolved.set(parsed.value.key, new Set(parsed.value.members));
    }
    const held = store.current?.segments;
    for (const key of referenced) {
      const previous = held?.get(key);
      if (!resolved.has(key) && previous !== undefined) resolved.set(key, previous);
    }
    return resolved;
  };

  const apply = (raw: unknown, ticket: number): boolean => {
    const bundled = isBundle(raw);
    const rawSegments = bundled ? raw.segments : [];
    if (!Array.isArray(rawSegments)) {
      lastFailure = new TypeError('Snapshot bundle segments must be an array');
      logger.error('Rejected invalid snapshot bundle; keeping the active one', lastFailure);
      return false;
    }
    const parsed = parseSnapshot(bundled ? raw.snapshot : raw, { definitions });
    if (!parsed.ok) {
      lastFailure = parsed.error;
      logger.error('Rejected invalid snapshot; keeping the active one', parsed.error);
      return false;
    }
    const next: ActiveSnapshot = { snapshot: parsed.value, segments: resolveSegments(parsed.value, rawSegments) };
    return store.replace(next, ticket);
  };

  const refresh = async (): Promise<boolean> => {
    const ticket = store.issueTicket();
    try {
      return apply(await source.load(), ticket);
    } catch (error) {
      lastFailure = error;
      logger.error('Snapshot load failed; keeping the active one', error);
      return false;
    }
  };

  if (options.allowStaleStartup === true) apply(options.fallbackSnapshot, store.issueTicket());

  let unsubscribe: Unsubscribe | undefined = source.subscribe?.((raw) => {
    apply(raw, store.issueTicket());
  });

  const readiness = refresh().then((loaded) => {
    if (!loaded && store.current === undefined) throw new StartupError(lastFailure);
  });
  readiness.catch(() => undefined);

  const featureOf = (key: string, active = store.current) => {
    const features = active?.snapshot.features;
    return features !== undefined && Object.hasOwn(features, key) ? features[key] : undefined;
  };

  const evaluateKey = (key: string, context: unknown): FlagEvaluation<unknown> => {
    const definition = definitionsByKey.get(key);
    const fallback = { value: definition?.default ?? false, enabled: false, reason: 'NOT_FOUND' } as const;
    const active = store.current;
    const feature = featureOf(key, active);
    if (active === undefined || feature === undefined) return fallback;
    try {
      return evaluate(feature, context, {
        flagKey: key,
        segments: active.segments,
        ...(definition?.context ? { contextSchema: definition.context } : {}),
      });
    } catch (error) {
      logger.error(`Evaluation of "${key}" failed; returning the default`, error);
      return fallback;
    }
  };

  return {
    isEnabled: (key, context = {}) => evaluateKey(key, context).enabled,
    get: (key) => evaluateKey(key, {}).value as never,
    evaluate: (key, context) => evaluateKey(key, context) as never,
    version: () => store.current?.snapshot.version,
    has: (key) => featureOf(key) !== undefined,
    getAll: () => store.current?.snapshot.features ?? NO_FEATURES,
    ready: () => readiness,
    refresh,
    close: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
