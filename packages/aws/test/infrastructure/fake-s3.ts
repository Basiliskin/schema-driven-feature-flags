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
