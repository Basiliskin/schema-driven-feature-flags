import { MAX_SEGMENT_MEMBERS, SEGMENT_SCHEMA_VERSION, parseSegment, type Result, type Segment } from '@featuresync/core';

export type SegmentCsvErrorReason = 'EMPTY_FILE' | 'MALFORMED_ROW' | 'HEADER' | 'TOO_MANY_MEMBERS' | 'INVALID_SEGMENT';

// Messages carry line numbers and counts only: members are personal data.
export interface SegmentCsvError {
  readonly reason: SegmentCsvErrorReason;
  readonly message: string;
}

export interface SegmentCsvTarget {
  readonly key: string;
  readonly version: number;
  readonly memberAttribute: string;
}

interface Row {
  readonly line: number;
  readonly value: string;
}

const fail = (reason: SegmentCsvErrorReason, message: string): Result<never, SegmentCsvError> => ({
  ok: false,
  error: { reason, message },
});

const nonBlankRows = (text: string): Row[] =>
  text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((raw, index) => ({ line: index + 1, value: raw.trim() }))
    .filter((row) => row.value !== '');

export function parseSegmentCsv(text: string, target: SegmentCsvTarget): Result<Segment, SegmentCsvError> {
  const rows = nonBlankRows(text);
  const body = rows[0]?.value === target.memberAttribute ? rows.slice(1) : rows;

  const malformed = body.find((row) => /[",]/.test(row.value));
  if (malformed) {
    return fail('MALFORMED_ROW', `Line ${String(malformed.line)} must hold exactly one unquoted value`);
  }
  const repeatedHeader = body.find((row) => row.value === target.memberAttribute);
  if (repeatedHeader) {
    return fail('HEADER', `Line ${String(repeatedHeader.line)} repeats the header; only the first line may be a header`);
  }
  if (body.length === 0) return fail('EMPTY_FILE', 'The file holds no members');

  const members = [...new Set(body.map((row) => row.value))];
  if (members.length > MAX_SEGMENT_MEMBERS) {
    return fail(
      'TOO_MANY_MEMBERS',
      `The file holds ${String(members.length)} unique members; the limit is ${String(MAX_SEGMENT_MEMBERS)}`,
    );
  }

  const parsed = parseSegment({ schemaVersion: SEGMENT_SCHEMA_VERSION, ...target, members });
  if (!parsed.ok) return fail('INVALID_SEGMENT', parsed.error.message);
  return parsed;
}
