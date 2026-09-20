import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type HttpMethod = 'GET' | 'POST';

export interface Route {
  readonly method: HttpMethod;
  /** Every method the address accepts, when it accepts more than `method`; drives the 405 Allow header. */
  readonly allow?: readonly HttpMethod[];
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void> | void;
}

export const send = (response: ServerResponse, status: number, html: string): void => {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
};

export const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'The address contains invalid percent-encoding.');
  }
};

/** `limit` is per route: only the segment upload raises it, so a stray large body elsewhere is still refused. */
export const readForm = async (request: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<URLSearchParams> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'The submitted form is too large.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
};
