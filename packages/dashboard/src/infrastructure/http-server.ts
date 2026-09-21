import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { browseEnvironment, viewSnapshotVersion } from '../application/browse-environment.js';
import { compareWithCurrent } from '../application/compare-versions.js';
import { applyDraftMerge, mergeDraft } from '../application/merge-draft.js';
import type { MergeChoices, Side } from '../domain/snapshot-merge.js';
import { editFeature, type EditFeaturePorts } from '../application/edit-feature.js';
import {
  listPublishedSegments,
  type ListPublishedSegmentsPorts,
  type PublishedSegmentsView,
} from '../application/list-published-segments.js';
import type { SegmentUploadPorts } from '../application/upload-segment.js';
import { describeFailure } from '../application/error-messages.js';
import type { FlagEdit, FlagType } from '../domain/flag-edit.js';
import {
  publishSnapshot,
  rollbackSnapshot,
  type WriteOutcome,
} from '../application/publish-snapshot.js';
import { renderEnvironmentPage, type EnvironmentPageState } from './views/environment-page.js';
import { renderErrorPage } from './views/error-page.js';
import { environmentPath } from './views/escape.js';
import type { EditDraft } from './views/feature-edit-form.js';
import { renderHomePage } from './views/home-page.js';
import type { Notice } from './views/layout.js';
import type { CreateDraft } from './views/new-flag-form.js';
import { renderChangesFragment } from './views/changes-dialog.js';
import { renderMergeFragment } from './views/merge-dialog.js';
import { CLIENT_SCRIPT, CLIENT_SCRIPT_PATH } from './views/client-script.js';
import { STYLESHEET, STYLESHEET_PATH } from './views/stylesheet.js';
import { renderVersionPage } from './views/version-page.js';
import { HttpError, MAX_BODY_BYTES, decodeSegment, readForm, send, type Route } from './http-primitives.js';
import { matchSegmentRoute } from './segment-routes.js';

export type DashboardPorts = EditFeaturePorts & SegmentUploadPorts & ListPublishedSegmentsPorts;

export interface DashboardServerOptions {
  readonly ports: DashboardPorts;
  /** 0 picks a free port. */
  readonly port: number;
  /** Receives unexpected errors; their details never reach the browser. Defaults to `console.error`. */
  readonly logError?: (error: unknown) => void;
}

export interface RunningDashboard {
  readonly url: string;
  close(): Promise<void>;
}

export const LOOPBACK_HOST = '127.0.0.1';
export { MAX_BODY_BYTES };

// A DNS-rebound or proxied request reaches the loopback socket under a foreign Host, so only the dashboard's own names pass.
export const isAllowedHost = (hostHeader: string | undefined, port: number): boolean => {
  const host = hostHeader?.toLowerCase();
  return host === `${LOOPBACK_HOST}:${String(port)}` || host === `localhost:${String(port)}`;
};

// Pages link assets with a content-hash query, so a new release gets a new URL and the old one can be cached for good.
const assetRoute = (contentType: string, body: string): Route => ({
  method: 'GET',
  handle: (_request, response) => {
    response.writeHead(200, {
      'content-type': `${contentType}; charset=utf-8`,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  },
});

const stylesheetRoute = assetRoute('text/css', STYLESHEET);
const clientScriptRoute = assetRoute('text/javascript', CLIENT_SCRIPT);

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

const isSide = (value: unknown): value is Side => value === 'mine' || value === 'theirs';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `{ key: side }` or `{ key: { field: side } }`, as the merge dialog's script sends it. */
const parseChoices = (text: string | null): MergeChoices => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '{}');
  } catch {
    throw new HttpError(400, 'The merge choices are not valid JSON.');
  }
  const valid =
    isPlainObject(parsed) &&
    Object.values(parsed).every((choice) => isSide(choice) || (isPlainObject(choice) && Object.values(choice).every(isSide)));
  if (!valid) throw new HttpError(400, 'The merge choices must map flags to "mine" or "theirs".');
  return parsed as MergeChoices;
};

const redirect = (response: ServerResponse, location: string): void => {
  response.writeHead(303, { location });
  response.end();
};

const parseVersion = (value: string | null | undefined): number => {
  if (value == null || !/^[1-9]\d{0,8}$/.test(value)) {
    throw new HttpError(400, 'The version must be a positive integer.');
  }
  return Number(value);
};

const outcomeNotices = (outcome: WriteOutcome): Notice[] => {
  if (outcome.kind === 'failure') return [{ kind: 'error', message: outcome.message, details: outcome.issues }];
  const notices: Notice[] = [{ kind: 'success', message: outcome.message }];
  if (outcome.warning !== undefined) notices.push({ kind: 'warning', message: outcome.warning });
  return notices;
};

const writeStatus = (outcome: WriteOutcome): number => {
  if (outcome.kind === 'success') return 200;
  return outcome.invalidInput === true ? 400 : 422;
};

const BASE_VERSION_MESSAGE = 'The edit form is out of date; reload the page and redo your edit.';
const TYPE_MESSAGE = 'Choose whether the new flag is a boolean or a config flag.';
const ATTACH_VALUE_MESSAGE =
  'The value starts like JSON but is not valid JSON; correct it, or remove the leading quote or bracket to save it as plain text.';

type EditRequest =
  | { readonly ok: true; readonly baseVersion: number; readonly edit: FlagEdit }
  | { readonly ok: false; readonly message: string; readonly invalidInput?: boolean };

const parseBaseVersion = (fields: URLSearchParams): number | undefined => {
  const baseVersion = fields.get('baseVersion');
  return baseVersion !== null && /^[1-9]\d{0,8}$/.test(baseVersion) ? Number(baseVersion) : undefined;
};

// NaN for a missing, empty or non-numeric field, so applyFlagEdit rejects it instead of Number('') silently meaning rule 0.
const parseNumber = (value: string | null): number => (value === null || value === '' ? Number.NaN : Number(value));

const parseRuleIndex = (fields: URLSearchParams): number => parseNumber(fields.get('ruleIndex'));

// A rule position comes from a hidden field, so anything Number() would stretch into an index -- '01', '1e0', ' 2 ', '+1' -- is a tampered form, not a choice.
const PLAIN_INDEX_PATTERN = /^(?:0|[1-9]\d*)$/;

const parseDetachIndex = (value: string | null): number =>
  value !== null && PLAIN_INDEX_PATTERN.test(value) ? Number(value) : Number.NaN;

/** JSON's own number grammar, so a version like 1.2.3 and an id like 007 stay text while 1e3 is a number. */
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const looksLikeJson = (text: string): boolean =>
  text.startsWith('{') ||
  text.startsWith('[') ||
  text.startsWith('"') ||
  text === 'true' ||
  text === 'false' ||
  text === 'null' ||
  JSON_NUMBER_PATTERN.test(text);

export type DecodedValue = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * A config flag's attached value as the operator typed it. Text that does not look like JSON is the string
 * itself, so `dark` needs no quotes; text that does look like JSON must parse, so a truncated object is
 * reported rather than published as its own source.
 */
export const decodeAttachValue = (raw: string): DecodedValue => {
  const text = raw.trim();
  if (!looksLikeJson(text)) return { ok: true, value: text };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

type EditParse = { readonly ok: true; readonly edit: FlagEdit } | { readonly ok: false; readonly message: string };

const okEdit = (edit: FlagEdit): EditParse => ({ ok: true, edit });

const UNLISTED_SEGMENT_MESSAGE =
  'Choose a segment from the list — that one is not published in this environment.';
const UNKNOWN_ATTRIBUTE_MESSAGE =
  'That segment was published before its member attribute was recorded, so it cannot be attached. Upload it again to record the attribute.';
const SEGMENTS_UNAVAILABLE_MESSAGE =
  'The list of published segments could not be read, so no segment can be attached right now.';

// The attribute always comes from the chosen segment's own pointer, so nothing the form submits can decide it.
const parseAttach = (key: string, fields: URLSearchParams, segments: PublishedSegmentsView): EditParse => {
  const value = decodeAttachValue(fields.get('value') ?? '');
  if (!value.ok) return { ok: false, message: ATTACH_VALUE_MESSAGE };
  if (segments.status === 'unavailable') return { ok: false, message: SEGMENTS_UNAVAILABLE_MESSAGE };
  const segmentKey = fields.get('segmentKey') ?? '';
  const chosen = segments.rows.find((row) => row.segmentKey === segmentKey);
  if (chosen === undefined) return { ok: false, message: UNLISTED_SEGMENT_MESSAGE };
  if (chosen.attribute.status === 'unknown') return { ok: false, message: UNKNOWN_ATTRIBUTE_MESSAGE };
  return okEdit({
    kind: 'attachSegment',
    key,
    segmentKey,
    memberAttribute: chosen.attribute.memberAttribute,
    value: value.value,
  });
};

const EDIT_PARSERS: Record<
  string,
  (key: string, fields: URLSearchParams, segments: PublishedSegmentsView) => EditParse
> = {
  setRollout: (key, fields) =>
    okEdit({
      kind: 'setRollout',
      key,
      ruleIndex: parseRuleIndex(fields),
      percentage: parseNumber(fields.get('percentage')),
      bucketBy: fields.get('bucketBy') ?? '',
      salt: fields.get('salt') ?? '',
    }),
  removeRollout: (key, fields) => okEdit({ kind: 'removeRollout', key, ruleIndex: parseRuleIndex(fields) }),
  enabled: (key, fields) => okEdit({ kind: 'enabled', key, enabled: fields.has('enabled') }),
  default: (key, fields) => okEdit({ kind: 'default', key, defaultJson: fields.get('default') ?? '' }),
  rules: (key, fields) => okEdit({ kind: 'setRules', key, rulesJson: fields.get('rules') ?? '' }),
  delete: (key) => okEdit({ kind: 'delete', key }),
  attachSegment: parseAttach,
  detachSegment: (key, fields) => okEdit({ kind: 'detachSegment', key, ruleIndex: parseDetachIndex(fields.get('ruleIndex')) }),
};

const FIELD_MESSAGE = `Choose one of these actions: ${Object.keys(EDIT_PARSERS).join(', ')}.`;

const parseEditForm = (key: string, fields: URLSearchParams, segments: PublishedSegmentsView): EditRequest => {
  const baseVersion = parseBaseVersion(fields);
  if (baseVersion === undefined) return { ok: false, message: BASE_VERSION_MESSAGE };
  const parse = EDIT_PARSERS[fields.get('field') ?? ''];
  if (parse === undefined) return { ok: false, message: FIELD_MESSAGE };
  const edit = parse(key, fields, segments);
  return edit.ok ? { ok: true, baseVersion, edit: edit.edit } : { ok: false, message: edit.message, invalidInput: true };
};

const isFlagType = (value: string | null): value is FlagType => value === 'boolean' || value === 'config';

const parseCreateForm = (fields: URLSearchParams): EditRequest => {
  const baseVersion = parseBaseVersion(fields);
  if (baseVersion === undefined) return { ok: false, message: BASE_VERSION_MESSAGE };
  const type = fields.get('type');
  if (!isFlagType(type)) return { ok: false, message: TYPE_MESSAGE };
  const key = fields.get('key') ?? '';
  const enabled = fields.has('enabled');
  const edit: FlagEdit =
    type === 'boolean'
      ? { kind: 'create', key, type, enabled }
      : { kind: 'create', key, type, enabled, defaultJson: fields.get('default') ?? '' };
  return { ok: true, baseVersion, edit };
};

const createDraftOf = (fields: URLSearchParams, message: string, issues: readonly string[]): CreateDraft => {
  const type = fields.get('type');
  return {
    key: fields.get('key') ?? '',
    type: type === 'config' ? 'config' : 'boolean',
    enabled: fields.has('enabled'),
    defaultJson: fields.get('default') ?? '',
    message,
    issues,
  };
};

const editDraftOf = (key: string, fields: URLSearchParams, message: string, issues: readonly string[]): EditDraft => {
  const defaultJson = fields.get('default');
  const rulesJson = fields.get('rules');
  const segmentKey = fields.get('segmentKey');
  const segmentValue = fields.get('value');
  return {
    key,
    enabled: fields.has('enabled'),
    ...(defaultJson === null ? {} : { defaultJson }),
    ...(rulesJson === null ? {} : { rulesJson }),
    ...(segmentKey === null ? {} : { segmentKey }),
    ...(segmentValue === null ? {} : { segmentValue }),
    message,
    issues,
  };
};

function createDashboardRequestHandler(
  ports: DashboardPorts,
  listeningPort: () => number,
  logError: (error: unknown) => void,
): (request: IncomingMessage, response: ServerResponse) => void {
  // Browsers send Origin on every form POST; a request without one is not from this dashboard's pages.
  const isSameOrigin = (request: IncomingMessage): boolean =>
    request.headers.origin === `http://${LOOPBACK_HOST}:${String(listeningPort())}`;

  const editRoute = (
    environment: string,
    parse: (fields: URLSearchParams, segments: PublishedSegmentsView) => EditRequest,
    draftState: (fields: URLSearchParams, message: string, issues: readonly string[]) => EnvironmentPageState,
  ): Route => ({
    method: 'POST',
    handle: async (request, response) => {
      const fields = await readForm(request);
      const segments = await listPublishedSegments(ports, environment);
      const parsed = parse(fields, segments);
      const outcome: WriteOutcome = parsed.ok
        ? await editFeature(ports, environment, parsed.baseVersion, parsed.edit)
        : {
            kind: 'failure',
            message: parsed.message,
            issues: [],
            ...(parsed.invalidInput === true ? { invalidInput: true } : {}),
          };
      const view = await browseEnvironment(ports, environment);
      const state = {
        notices: outcomeNotices(outcome),
        publishedSegments: segments,
        ...(outcome.kind === 'failure' ? draftState(fields, outcome.message, outcome.issues) : {}),
        ...(parsed.ok && outcome.kind === 'failure' && outcome.conflict !== undefined
          ? { conflict: { since: outcome.conflict.since, key: parsed.edit.key } }
          : {}),
      };
      send(response, writeStatus(outcome), renderEnvironmentPage(view, state));
    },
  });

  const match = (segments: readonly string[], method: string | undefined): Route | undefined => {
    if (segments.length === 0) {
      return {
        method: 'GET',
        handle: (_request, response, url) => {
          const environment = url.searchParams.get('env');
          if (environment !== null && environment !== '') redirect(response, environmentPath(environment));
          else send(response, 200, renderHomePage());
        },
      };
    }
    const path = `/${segments.join('/')}`;
    if (path === STYLESHEET_PATH) return stylesheetRoute;
    if (path === CLIENT_SCRIPT_PATH) return clientScriptRoute;
    if (segments[0] !== 'env' || segments.length < 2 || segments.length > 4) return undefined;
    const environment = decodeSegment(segments[1] as string);
    if (segments.length === 2) {
      return {
        method: 'GET',
        handle: async (_request, response) => {
          send(response, 200, renderEnvironmentPage(await browseEnvironment(ports, environment), {
            publishedSegments: await listPublishedSegments(ports, environment),
          }));
        },
      };
    }
    // Polled by open pages so an operator learns when someone else has published in the meantime.
    if (segments.length === 3 && segments[2] === 'current-version') {
      return {
        method: 'GET',
        handle: async (_request, response) => {
          sendJson(response, 200, { version: (await ports.readCurrentVersion(environment)) ?? null });
        },
      };
    }
    if (segments.length === 3 && segments[2] === 'changes') {
      return {
        method: 'GET',
        handle: async (_request, response, url) => {
          const comparison = await compareWithCurrent(ports, environment, parseVersion(url.searchParams.get('since')));
          const edited = url.searchParams.get('edited') ?? undefined;
          send(
            response,
            200,
            comparison.status === 'up-to-date'
              ? '<p class="muted">You already have the latest version.</p>'
              : renderChangesFragment(comparison, edited),
          );
        },
      };
    }
    // POST only because a draft can be large; it reads snapshots and writes nothing.
    if (segments.length === 3 && segments[2] === 'merge') {
      return {
        method: 'POST',
        handle: async (request, response) => {
          const fields = await readForm(request);
          const merge = await mergeDraft(ports, environment, parseVersion(fields.get('since')), fields.get('snapshot') ?? '');
          send(response, 200, renderMergeFragment(merge));
        },
      };
    }
    // Applies the operator's merge choices to their draft; answers with the merged draft, never publishes it.
    if (segments.length === 4 && segments[2] === 'merge' && segments[3] === 'apply') {
      return {
        method: 'POST',
        handle: async (request, response) => {
          const fields = await readForm(request);
          const result = await applyDraftMerge(
            ports,
            environment,
            parseVersion(fields.get('since')),
            parseVersion(fields.get('to')),
            fields.get('snapshot') ?? '',
            parseChoices(fields.get('choices')),
          );
          sendJson(response, result.status === 'merged' ? 200 : 409, result);
        },
      };
    }
    if (segments.length === 3 && segments[2] === 'publish') {
      return {
        method: 'POST',
        handle: async (request, response) => {
          const fields = await readForm(request);
          const draft = fields.get('snapshot') ?? '';
          const outcome = await publishSnapshot(ports, environment, draft, parseBaseVersion(fields));
          const view = await browseEnvironment(ports, environment);
          const state = {
            notices: outcomeNotices(outcome),
            publishedSegments: await listPublishedSegments(ports, environment),
            ...(outcome.kind === 'failure' ? { draft } : {}),
            ...(outcome.kind === 'failure' && outcome.conflict !== undefined ? { conflict: outcome.conflict } : {}),
          };
          send(response, writeStatus(outcome), renderEnvironmentPage(view, state));
        },
      };
    }
    if (segments.length === 3 && segments[2] === 'rollback') {
      return {
        method: 'POST',
        handle: async (request, response) => {
          const version = parseVersion((await readForm(request)).get('version'));
          const outcome = await rollbackSnapshot(ports, environment, version);
          const view = await browseEnvironment(ports, environment);
          send(response, writeStatus(outcome), renderEnvironmentPage(view, {
            notices: outcomeNotices(outcome),
            publishedSegments: await listPublishedSegments(ports, environment),
          }));
        },
      };
    }
    if (segments.length === 3 && segments[2] === 'features') {
      return editRoute(environment, parseCreateForm, (fields, message, issues) => ({
        createDraft: createDraftOf(fields, message, issues),
      }));
    }
    if (segments.length === 4 && segments[2] === 'features') {
      const key = decodeSegment(segments[3] as string);
      return editRoute(
        environment,
        (fields, segments) => parseEditForm(key, fields, segments),
        (fields, message, issues) => ({ editDraft: editDraftOf(key, fields, message, issues) }),
      );
    }
    const segmentRoute = matchSegmentRoute(ports, environment, segments, method);
    if (segmentRoute !== undefined) return segmentRoute;
    if (segments.length === 4 && segments[2] === 'versions') {
      return {
        method: 'GET',
        handle: async (_request, response) => {
          const version = parseVersion(segments[3]);
          send(response, 200, renderVersionPage(await viewSnapshotVersion(ports, environment, version)));
        },
      };
    }
    return undefined;
  };

  const dispatch = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(String(request.url), 'http://localhost');
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    const route = match(segments, request.method);
    if (route === undefined) throw new HttpError(404, 'There is no page at this address.');
    if (route.method !== request.method) {
      response.setHeader('allow', (route.allow ?? [route.method]).join(', '));
      throw new HttpError(405, 'This address does not accept that request method.');
    }
    if (route.method === 'POST' && !isSameOrigin(request)) {
      throw new HttpError(403, 'Changes are only accepted from this dashboard’s own pages.');
    }
    await route.handle(request, response, url);
  };

  return (request, response) => {
    if (!isAllowedHost(request.headers.host, listeningPort())) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('This dashboard only answers requests addressed to 127.0.0.1 or localhost on its own port.');
      return;
    }
    dispatch(request, response).catch((error: unknown) => {
      if (error instanceof HttpError) {
        send(response, error.status, renderErrorPage(String(error.status), error.message));
        return;
      }
      logError(error);
      send(response, 500, renderErrorPage('500', describeFailure(error).message));
    });
  };
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<RunningDashboard> {
  let port = 0;
  const handler = createDashboardRequestHandler(
    options.ports,
    () => port,
    options.logError ??
      ((error) => {
        console.error(error);
      }),
  );
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  ({ port } = server.address() as AddressInfo);
  return {
    url: `http://${LOOPBACK_HOST}:${String(port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
