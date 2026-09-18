import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { errorShape } from './s3-errors.js';

export interface S3Text {
  readonly text: string | undefined;
  readonly etag: string | undefined;
}

export const readObjectText = async (
  client: Pick<S3Client, 'send'>,
  bucket: string,
  key: string,
  ifNoneMatch?: string,
): Promise<S3Text> => {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(ifNoneMatch === undefined ? {} : { IfNoneMatch: ifNoneMatch }),
  });
  const response = await client.send(command);
  return { text: await response.Body?.transformToString(), etag: response.ETag };
};

export const isNotFound = (error: unknown): boolean => {
  const { name, status } = errorShape(error);
  return name === 'NoSuchKey' || status === 404;
};

// With GetObject-only permissions S3 answers 403 rather than 404 for a missing key.
export const isMissing = (error: unknown): boolean => {
  if (isNotFound(error)) return true;
  const { name, status } = errorShape(error);
  return name === 'AccessDenied' || status === 403;
};
