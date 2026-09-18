import { z } from 'zod';
import { environmentSchema, snapshotKeyFor, versionSchema } from './current-pointer.js';

export const NOTIFICATION_SCHEMA_VERSION = 1;

export interface ChangeNotification {
  readonly schemaVersion: typeof NOTIFICATION_SCHEMA_VERSION;
  readonly environment: string;
  readonly version: number;
  readonly snapshotKey: string;
}

export type InvalidNotificationReason = 'INVALID_JSON' | 'UNSUPPORTED_ENVELOPE' | 'INVALID_NOTIFICATION';

export interface InvalidNotification {
  readonly reason: InvalidNotificationReason;
  readonly message: string;
}

export type NotificationResult =
  | { readonly ok: true; readonly value: ChangeNotification }
  | { readonly ok: false; readonly error: InvalidNotification };

const notificationSchema = z
  .object({
    schemaVersion: z.literal(NOTIFICATION_SCHEMA_VERSION),
    environment: environmentSchema,
    version: versionSchema,
    snapshotKey: z.string(),
  })
  .refine((message) => message.snapshotKey === snapshotKeyFor(message.environment, message.version), {
    path: ['snapshotKey'],
    message: 'snapshotKey must equal <environment>/snapshots/<version>.json',
  });

const snsEnvelopeSchema = z.object({ Type: z.string(), Message: z.unknown() });

export function buildChangeNotification(environment: string, version: number): string {
  const notification: ChangeNotification = {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    environment: environmentSchema.parse(environment),
    version: versionSchema.parse(version),
    snapshotKey: snapshotKeyFor(environment, version),
  };
  return JSON.stringify(notification);
}

const invalid = (reason: InvalidNotificationReason, message: string): NotificationResult => ({
  ok: false,
  error: { reason, message },
});

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function parseChangeNotification(body: string): NotificationResult {
  const outer = parseJson(body);
  if (!outer.ok) return invalid('INVALID_JSON', 'body is not JSON');

  let payload = outer.value;
  const envelope = snsEnvelopeSchema.safeParse(payload);
  if (envelope.success) {
    if (envelope.data.Type !== 'Notification' || typeof envelope.data.Message !== 'string') {
      return invalid('UNSUPPORTED_ENVELOPE', `unsupported SNS message type ${JSON.stringify(envelope.data.Type)}`);
    }
    const inner = parseJson(envelope.data.Message);
    if (!inner.ok) return invalid('INVALID_JSON', 'SNS Message is not JSON');
    payload = inner.value;
  }

  const parsed = notificationSchema.safeParse(payload);
  if (parsed.success) return { ok: true, value: Object.freeze(parsed.data) };
  return invalid(
    'INVALID_NOTIFICATION',
    parsed.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`).join('; '),
  );
}
