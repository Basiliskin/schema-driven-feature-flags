import { MAX_SEGMENT_MEMBERS } from '@featuresync/core';
import { describe, expect, it, vi } from 'vitest';
import {
  uploadSegment,
  type SegmentUploadPorts,
  type SegmentUploadRequest,
  type SegmentUploadResult,
} from '../../src/application/upload-segment.js';

const pointer = (version: number) => ({
  schemaVersion: 1 as const,
  environment: 'production',
  segmentKey: 'beta',
  version,
  objectKey: `production/segments/beta/${String(version)}.json`,
});

const portsThat = (publishSegment: SegmentUploadPorts['publishSegment']) => {
  const publish = vi.fn(publishSegment);
  const ports: SegmentUploadPorts = {
    publishSegment: publish,
    readSegmentVersion: () => Promise.resolve(null),
  };
  return { ports, publish };
};

const publishingPorts = (version = 5) => portsThat(() => Promise.resolve(pointer(version)));

const throwingPorts = (error: Error) => portsThat(() => Promise.reject(error));

const request = (overrides: Partial<SegmentUploadRequest> = {}): SegmentUploadRequest => ({
  key: 'beta',
  memberAttribute: 'userId',
  csv: 'userId\nalice\nbob\n',
  expectedCurrentVersion: 4,
  ...overrides,
});

const failure = (result: SegmentUploadResult) => {
  expect(result.ok).toBe(false);
  return result as Extract<SegmentUploadResult, { ok: false }>;
};

describe('uploadSegment', () => {
  it('publishes the parsed members and returns the new Segment Pointer', async () => {
    const { ports, publish } = publishingPorts(5);

    const result = await uploadSegment(ports, 'production', request());

    expect(result).toEqual({ ok: true, pointer: pointer(5) });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[1]).toEqual({
      key: 'beta',
      memberAttribute: 'userId',
      members: ['alice', 'bob'],
      expectedCurrentVersion: 4,
    });
  });

  it('passes a null expected version through unchanged, so a first upload asserts "no segment yet"', async () => {
    const { ports, publish } = publishingPorts(1);

    await uploadSegment(ports, 'production', request({ expectedCurrentVersion: null }));

    expect(publish.mock.calls[0]?.[1].expectedCurrentVersion).toBeNull();
  });

  describe('rejects an invalid CSV without ever calling the publisher', () => {
    const cases: readonly (readonly [string, string, Partial<SegmentUploadRequest>])[] = [
      ['EMPTY_FILE', 'a file holding only its header', { csv: 'userId\n' }],
      ['HEADER', 'a repeated header row', { csv: 'userId\nalice\nuserId\n' }],
      ['MALFORMED_ROW', 'a row holding a comma', { csv: 'userId\nalice,bob\n' }],
      [
        'TOO_MANY_MEMBERS',
        'more members than the limit',
        { csv: `userId\n${Array.from({ length: MAX_SEGMENT_MEMBERS + 1 }, (_, i) => `m${String(i)}`).join('\n')}\n` },
      ],
      ['INVALID_SEGMENT', 'a segment key the contract rejects', { key: 'not a valid key' }],
    ];

    it.each(cases)('returns %s for %s', async (reason, _description, overrides) => {
      const { ports, publish } = publishingPorts();

      const result = failure(await uploadSegment(ports, 'production', request(overrides)));

      expect(result.reason).toBe(reason);
      expect(publish).toHaveBeenCalledTimes(0);
    });
  });

  it('names the offending line without echoing the member on it', async () => {
    const { ports } = publishingPorts();

    const result = failure(
      await uploadSegment(ports, 'production', request({ csv: 'userId\nbob\nalice@example.com,extra\n' })),
    );

    expect(JSON.stringify(result)).not.toContain('alice@example.com');
    expect(result.message).toContain('Line 3');
  });

  it.each([
    ['CONFLICT', 'CONFLICT'],
    ['VERSION_EXISTS', 'VERSION_EXISTS'],
    ['INVALID_POINTER', 'REQUEST_FAILED'],
  ])('maps a publisher %s to %s', async (thrown, expected) => {
    const { ports } = throwingPorts(Object.assign(new Error(`${thrown} for s3 object k`), { reason: thrown }));

    const result = failure(await uploadSegment(ports, 'production', request()));

    expect(result.reason).toBe(expected);
  });

  it('maps an error carrying no reason to REQUEST_FAILED', async () => {
    const { ports } = throwingPorts(new Error('socket hang up'));

    const result = failure(await uploadSegment(ports, 'production', request()));

    expect(result.reason).toBe('REQUEST_FAILED');
    expect(result.message).not.toContain('socket hang up');
  });
});
