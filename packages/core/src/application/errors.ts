/**
 * Rejects `ready()` when no valid snapshot could be loaded at startup and
 * `allowStaleStartup` did not provide a usable fallback. `cause` holds the load or validation failure.
 */
export class StartupError extends Error {
  override readonly name = 'StartupError';

  constructor(cause: unknown) {
    super('FeatureSync could not load a valid snapshot at startup', { cause });
  }
}
