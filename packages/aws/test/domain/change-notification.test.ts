import { describe, expect, it } from 'vitest';
import { buildChangeNotification, parseChangeNotification } from '../../src/domain/change-notification.js';

const validMessage = () => ({
  schemaVersion: 1,
  environment: 'production',
  version: 43,
  snapshotKey: 'production/snapshots/43.json',
});

const snsEnvelope = (message: unknown, type = 'Notification') =>
  JSON.stringify({ Type: type, MessageId: 'id-1', TopicArn: 'arn:aws:sns:eu-west-1:1:topic', Message: message });

const errorOf = (body: string) => {
  const result = parseChangeNotification(body);
  if (result.ok) throw new Error('expected the notification to be rejected');
  return result.error;
};

describe('buildChangeNotification', () => {
  it('builds the message body for an environment and version', () => {
    expect(JSON.parse(buildChangeNotification('production', 43))).toEqual(validMessage());
  });

  it('round-trips through the parser', () => {
    expect(parseChangeNotification(buildChangeNotification('staging', 7))).toEqual({
      ok: true,
      value: { schemaVersion: 1, environment: 'staging', version: 7, snapshotKey: 'staging/snapshots/7.json' },
    });
  });

  it.each([
    ['', 1],
    ['prod/eu', 1],
    ['prod', 0],
    ['prod', 1.5],
  ])('refuses environment %j with version %j', (environment, version) => {
    expect(() => buildChangeNotification(environment, version)).toThrow();
  });
});

describe('parseChangeNotification', () => {
  it('accepts a raw message', () => {
    expect(parseChangeNotification(JSON.stringify(validMessage()))).toEqual({ ok: true, value: validMessage() });
  });

  it('unwraps an SNS Notification envelope', () => {
    expect(parseChangeNotification(snsEnvelope(JSON.stringify(validMessage())))).toEqual({
      ok: true,
      value: validMessage(),
    });
  });

  it('ignores unknown extra fields', () => {
    expect(parseChangeNotification(JSON.stringify({ ...validMessage(), publishedBy: 'ci' }))).toEqual({
      ok: true,
      value: validMessage(),
    });
  });

  it('rejects a body that is not JSON', () => {
    expect(errorOf('not json').reason).toBe('INVALID_JSON');
  });

  it('rejects an SNS Message that is not JSON', () => {
    expect(errorOf(snsEnvelope('not json')).reason).toBe('INVALID_JSON');
  });

  it.each(['SubscriptionConfirmation', 'UnsubscribeConfirmation'])('rejects an SNS %s envelope', (type) => {
    expect(errorOf(snsEnvelope(JSON.stringify(validMessage()), type)).reason).toBe('UNSUPPORTED_ENVELOPE');
  });

  it('rejects an SNS envelope whose Message is not a string', () => {
    expect(errorOf(snsEnvelope(validMessage())).reason).toBe('UNSUPPORTED_ENVELOPE');
  });

  it('rejects a snapshotKey that does not match environment and version', () => {
    const error = errorOf(JSON.stringify({ ...validMessage(), snapshotKey: 'production/snapshots/42.json' }));

    expect(error.reason).toBe('INVALID_NOTIFICATION');
    expect(error.message).toContain('snapshotKey');
  });

  it.each(['schemaVersion', 'environment', 'version', 'snapshotKey'])('rejects a message missing %s', (field) => {
    const message = Object.fromEntries(Object.entries(validMessage()).filter(([key]) => key !== field));
    const error = errorOf(JSON.stringify(message));

    expect(error.reason).toBe('INVALID_NOTIFICATION');
    expect(error.message).toContain(field);
  });

  it.each([
    { schemaVersion: 2 },
    { environment: '' },
    { environment: 'prod/eu' },
    { version: 0 },
    { version: '43' },
  ])('rejects invalid field %j', (override) => {
    expect(errorOf(JSON.stringify({ ...validMessage(), ...override })).reason).toBe('INVALID_NOTIFICATION');
  });

  it.each(['null', '[]', '"text"'])('rejects the non-object body %s', (body) => {
    expect(errorOf(body).reason).toBe('INVALID_NOTIFICATION');
  });
});
