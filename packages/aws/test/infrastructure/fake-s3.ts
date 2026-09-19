import type { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { vi } from 'vitest';

export type StoredObject =
  | { readonly body?: string; readonly etag?: string; readonly lastModified?: Date }
  | { readonly error: Error };

export const pointer = (version: number, environment = 'production') => ({
  schemaVersion: 1,
  environment,
  version,
  snapshotKey: `${environment}/snapshots/${String(version)}.json`,
});

export const current = (version: number, etag = `"v${String(version)}"`): StoredObject => ({
  body: JSON.stringify(pointer(version)),
  etag,
});

export const s3Error = (name: string, httpStatusCode: number) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

/** An S3 GetObject stand-in over a mutable key map; answers a matching IfNoneMatch with `notModified`. */
export const fakeS3 = (
  objects: Record<string, StoredObject>,
  notModified: () => Error = () => s3Error('NotModified', 304),
) => {
  const keys: string[] = [];
  const send = vi.fn((command: GetObjectCommand) => {
    const key = command.input.Key ?? '';
    keys.push(key);
    const object = objects[key] ?? { error: s3Error('NoSuchKey', 404) };
    if ('error' in object) return Promise.reject(object.error);
    const { body, etag } = object;
    if (etag !== undefined && command.input.IfNoneMatch === etag) return Promise.reject(notModified());
    return Promise.resolve({
      ETag: etag,
      Body: body === undefined ? undefined : { transformToString: () => Promise.resolve(body) },
    });
  });
  return { client: { send } as unknown as Pick<S3Client, 'send'>, keys, send };
};

export const segmentFile = (key: string, version: number) => ({
  schemaVersion: 1,
  key,
  version,
  memberAttribute: 'userId',
  members: ['secret-member'],
});

export const segmentPointer = (key: string, version: number, environment = 'production') => ({
  schemaVersion: 1,
  environment,
  segmentKey: key,
  version,
  objectKey: `${environment}/segments/${key}/${String(version)}.json`,
});

/** A valid snapshot whose one feature has a rule per given segment key. */
export const snapshotUsing = (...segmentKeys: string[]) => ({
  schemaVersion: 2,
  environment: 'production',
  version: 2,
  createdAt: '2026-09-19T06:00:00.000Z',
  createdBy: 'test',
  previousVersion: 1,
  reason: 'test',
  features: {
    beta: {
      type: 'boolean',
      enabled: false,
      rules: segmentKeys.map((key) => ({ when: { userId: { inSegment: key } }, enabled: true })),
    },
  },
});

/** The pointer and version objects of one published segment. */
export const publishedSegment = (key: string, version: number, etag = `"${key}-${String(version)}"`) => ({
  [`production/segments/${key}/current.json`]: { body: JSON.stringify(segmentPointer(key, version)), etag },
  [`production/segments/${key}/${String(version)}.json`]: { body: JSON.stringify(segmentFile(key, version)) },
});
