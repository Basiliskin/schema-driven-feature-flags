import type { IncomingMessage, ServerResponse } from 'node:http';
import { segmentKeySchema } from '@featuresync/core';
import { listReferencedSegments, type ListReferencedSegmentsPorts } from '../application/list-referenced-segments.js';
import { uploadSegment, type SegmentUploadFailureReason, type SegmentUploadPorts } from '../application/upload-segment.js';
import { HttpError, decodeSegment, readForm, send, type HttpMethod, type Route } from './http-primitives.js';
import type { Notice } from './views/layout.js';
import { renderSegmentListPage, type SegmentDraft } from './views/segment-list-page.js';
import { renderSegmentPage } from './views/segment-page.js';

export type SegmentRoutePorts = SegmentUploadPorts & ListReferencedSegmentsPorts;

/** 100,000 members of up to 256 characters, URL-encoded. Only the upload POST reads a body this large. */
export const MAX_SEGMENT_CSV_BYTES = 32 * 1024 * 1024;

const UPLOAD_STATUS: Record<SegmentUploadFailureReason, number> = {
  EMPTY_FILE: 400,
  MALFORMED_ROW: 400,
  HEADER: 400,
  TOO_MANY_MEMBERS: 400,
  INVALID_SEGMENT: 400,
  CONFLICT: 422,
  VERSION_EXISTS: 422,
  REQUEST_FAILED: 502,
};

const INVALID_KEY_MESSAGE =
  'That Segment Key is not valid. Use 1-64 letters, digits, "-" or "_", starting with a letter or digit.';
const KEY_IN_USE_MESSAGE = 'That Segment Key is already in use; open it from the list to upload a new version.';
const PRECHECK_FAILED_MESSAGE = 'The segment could not be created because its current pointer could not be read.';

const EXPECTED_VERSION_MESSAGE = 'The upload form is out of date; reload the page and choose the file again.';

// An empty field means "this segment does not exist yet", which is not the same as version 0.
const parseExpectedVersion = (value: string | null): number | null => {
  if (value === null || value === '') return null;
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new HttpError(400, EXPECTED_VERSION_MESSAGE);
  return Number(value);
};

export function matchSegmentRoute(
  ports: SegmentRoutePorts,
  environment: string,
  segments: readonly string[],
  method: string | undefined,
): Route | undefined {
  if (segments[2] !== 'segments' || segments.length < 3 || segments.length > 4) return undefined;

  if (segments.length === 3) {
    const sendList = async (
      response: ServerResponse,
      status: number,
      notices: readonly Notice[],
      draft?: SegmentDraft,
    ): Promise<void> => {
      const rows = await listReferencedSegments(ports, environment);
      send(response, status, renderSegmentListPage({ environment, rows }, draft === undefined ? { notices } : { notices, draft }));
    };

    const handlers = {
      GET: async (_request: IncomingMessage, response: ServerResponse) => {
        await sendList(response, 200, []);
      },
      POST: async (request: IncomingMessage, response: ServerResponse) => {
        const fields = await readForm(request, MAX_SEGMENT_CSV_BYTES);
        // The publisher trims the key it stores, so validate the trimmed value rather than the raw field.
        const typedKey = (fields.get('key') ?? '').trim();
        const memberAttribute = fields.get('memberAttribute') ?? '';
        // The CSV is deliberately absent: echoing it back would put member rows into the HTML.
        const draft: SegmentDraft = { key: typedKey, memberAttribute };
        if (!segmentKeySchema.safeParse(typedKey).success) {
          await sendList(response, 400, [{ kind: 'error', message: INVALID_KEY_MESSAGE }], draft);
          return;
        }

        let published: number | null;
        try {
          published = await ports.readSegmentVersion(environment, typedKey);
        } catch {
          await sendList(response, 502, [{ kind: 'error', message: PRECHECK_FAILED_MESSAGE }], draft);
          return;
        }
        if (published !== null) {
          await sendList(response, 422, [{ kind: 'error', message: KEY_IN_USE_MESSAGE }], draft);
          return;
        }

        const result = await uploadSegment(ports, environment, {
          key: typedKey,
          memberAttribute,
          csv: fields.get('csv') ?? '',
          expectedCurrentVersion: null,
        });
        await sendList(
          response,
          result.ok ? 200 : UPLOAD_STATUS[result.reason],
          [
            result.ok
              ? { kind: 'success', message: `Created as version ${String(result.pointer.version)}.` }
              : { kind: 'error', message: result.message },
          ],
          result.ok ? undefined : draft,
        );
      },
    } satisfies Record<HttpMethod, Route['handle']>;

    const matched: HttpMethod = method === 'POST' ? 'POST' : 'GET';
    return { method: matched, allow: Object.keys(handlers) as HttpMethod[], handle: handlers[matched] };
  }

  const key = decodeSegment(segments[3] as string);

  if (method === 'POST') {
    return {
      method: 'POST',
      handle: async (request, response) => {
        const fields = await readForm(request, MAX_SEGMENT_CSV_BYTES);
        const result = await uploadSegment(ports, environment, {
          key,
          memberAttribute: fields.get('memberAttribute') ?? '',
          csv: fields.get('csv') ?? '',
          expectedCurrentVersion: parseExpectedVersion(fields.get('expectedCurrentVersion')),
        });
        const currentVersion = result.ok ? result.pointer.version : await ports.readSegmentVersion(environment, key);
        const notice = result.ok
          ? { kind: 'success' as const, message: `Uploaded as version ${String(result.pointer.version)}.` }
          : { kind: 'error' as const, message: result.message };
        send(
          response,
          result.ok ? 200 : UPLOAD_STATUS[result.reason],
          renderSegmentPage({ environment, key, currentVersion }, { notices: [notice] }),
        );
      },
    };
  }

  return {
    method: 'GET',
    handle: async (_request, response) => {
      const currentVersion = await ports.readSegmentVersion(environment, key);
      send(response, 200, renderSegmentPage({ environment, key, currentVersion }));
    },
  };
}
