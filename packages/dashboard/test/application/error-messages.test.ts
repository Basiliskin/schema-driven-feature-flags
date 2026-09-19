import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  FETCH_ERROR_MESSAGES,
  PUBLISH_ERROR_MESSAGES,
  UNEXPECTED_ERROR_MESSAGE,
} from '../../src/application/error-messages.js';

const awsError = (name: string, reason: unknown, cause?: unknown) =>
  Object.assign(new Error(`${String(reason)} for s3 object prod/current.json`, { cause }), { name, reason });

const SECRET = 'AKIAIOSFODNN7EXAMPLE';

describe('error message maps', () => {
  it.each([
    ['S3PublishError', PUBLISH_ERROR_MESSAGES, 7],
    ['S3FetchError', FETCH_ERROR_MESSAGES, 6],
  ] as const)('gives every %s reason a distinct, non-empty message', (name, messages, count) => {
    const reasons = Object.keys(messages);
    expect(reasons).toHaveLength(count);
    const described = reasons.map((reason) => describeFailure(awsError(name, reason)).message);
    for (const message of described) expect(message).not.toBe('');
    expect(new Set(described).size).toBe(count);
    expect(described).toEqual(Object.values(messages));
  });

  it('explains how to recover from VERSION_EXISTS and CONFLICT', () => {
    expect(PUBLISH_ERROR_MESSAGES.VERSION_EXISTS).toMatch(/rollback.*hidden.*by hand/s);
    expect(PUBLISH_ERROR_MESSAGES.CONFLICT).toMatch(/another writer.*reload.*retry/is);
  });
});

describe('describeFailure', () => {
  it('renders snapshot validation issues as path: message lines', () => {
    const cause = { issues: [{ path: 'features.x.type', message: 'expected boolean or config' }] };
    for (const reason of ['INVALID_SNAPSHOT', 'INVALID_POINTER']) {
      expect(describeFailure(awsError('S3PublishError', reason, cause)).issues).toEqual([
        'features.x.type: expected boolean or config',
      ]);
    }
  });

  it('lists no issues when the cause carries none or the reason is not a validation failure', () => {
    expect(describeFailure(awsError('S3PublishError', 'INVALID_SNAPSHOT', new Error('bad'))).issues).toEqual([]);
    expect(describeFailure(awsError('S3PublishError', 'INVALID_SNAPSHOT')).issues).toEqual([]);
    expect(
      describeFailure(awsError('S3PublishError', 'CONFLICT', { issues: [{ path: 'a', message: 'b' }] })).issues,
    ).toEqual([]);
  });

  it.each([
    ['a non-object', 'boom'],
    ['null', null],
    ['an unrelated error', new Error(`secret ${SECRET}`)],
    ['an unknown reason', awsError('S3PublishError', 'NEW_REASON')],
    ['a reason under the wrong error name', awsError('S3FetchError', 'CONFLICT')],
    ['a non-string reason', awsError('S3PublishError', 1)],
  ])('falls back to a generic message for %s', (_label, error) => {
    expect(describeFailure(error)).toEqual({ message: UNEXPECTED_ERROR_MESSAGE, issues: [] });
  });

  it('never echoes the cause, key or credentials', () => {
    const described = describeFailure(awsError('S3PublishError', 'REQUEST_FAILED', new Error(`denied for ${SECRET}`)));
    expect(JSON.stringify(described)).not.toContain(SECRET);
    expect(JSON.stringify(described)).not.toContain('current.json');
    expect(Object.keys(described).sort()).toEqual(['issues', 'message']);
  });
});
