import { parseSegmentCsv, type SegmentCsvErrorReason, type SegmentPointer } from '@featuresync/aws';

export type SegmentUploadFailureReason = SegmentCsvErrorReason | 'CONFLICT' | 'VERSION_EXISTS' | 'REQUEST_FAILED';

export interface SegmentUpload {
  readonly key: string;
  readonly memberAttribute: string;
  readonly members: readonly string[];
  /** The Segment Version the page was built on, or `null` for "this segment does not exist yet". */
  readonly expectedCurrentVersion: number | null;
}

export interface SegmentUploadPorts {
  publishSegment(environment: string, upload: SegmentUpload): Promise<SegmentPointer>;
  /** Resolves to `null` when the segment has never been published. */
  readSegmentVersion(environment: string, key: string): Promise<number | null>;
}

export type SegmentUploadResult =
  | { readonly ok: true; readonly pointer: SegmentPointer }
  | { readonly ok: false; readonly reason: SegmentUploadFailureReason; readonly message: string };

export interface SegmentUploadRequest {
  readonly key: string;
  readonly memberAttribute: string;
  readonly csv: string;
  readonly expectedCurrentVersion: number | null;
}

const CONFLICT_MESSAGE = 'Someone else uploaded this segment meanwhile; reload the page and upload again';
const VERSION_EXISTS_MESSAGE = 'That Segment Version already exists; reload the page and upload again';
const REQUEST_FAILED_MESSAGE = 'The segment could not be uploaded';

const publishFailure = (error: unknown): SegmentUploadResult => {
  const reason = (error as { reason?: unknown }).reason;
  if (reason === 'CONFLICT') return { ok: false, reason: 'CONFLICT', message: CONFLICT_MESSAGE };
  if (reason === 'VERSION_EXISTS') return { ok: false, reason: 'VERSION_EXISTS', message: VERSION_EXISTS_MESSAGE };
  return { ok: false, reason: 'REQUEST_FAILED', message: REQUEST_FAILED_MESSAGE };
};

/**
 * Turns CSV text into a new Segment Version. The parser's messages carry line numbers and counts only, so they
 * are safe to show; a member value is never read back out of the file into a result.
 */
export async function uploadSegment(
  ports: SegmentUploadPorts,
  environment: string,
  request: SegmentUploadRequest,
): Promise<SegmentUploadResult> {
  const { key, memberAttribute, expectedCurrentVersion } = request;
  // The publisher assigns the stored version; this one only satisfies the segment contract while parsing.
  const parsed = parseSegmentCsv(request.csv, { key, version: 1, memberAttribute });
  if (!parsed.ok) return { ok: false, reason: parsed.error.reason, message: parsed.error.message };

  try {
    const pointer = await ports.publishSegment(environment, {
      key,
      memberAttribute: parsed.value.memberAttribute,
      members: parsed.value.members,
      expectedCurrentVersion,
    });
    return { ok: true, pointer };
  } catch (error) {
    return publishFailure(error);
  }
}
