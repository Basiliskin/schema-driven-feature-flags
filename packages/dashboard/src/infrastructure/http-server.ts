import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { browseEnvironment, viewSnapshotVersion } from '../application/browse-environment.js';
import { editFeature, type EditFeaturePorts } from '../application/edit-feature.js';
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
import { STYLESHEET, STYLESHEET_PATH } from './views/stylesheet.js';
import { renderVersionPage } from './views/version-page.js';

export type DashboardPorts = EditFeaturePorts;

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
export const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Route {
  readonly method: 'GET' | 'POST';
  readonly handle: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void> | void;
}

const send = (response: ServerResponse, status: number, html: string): void => {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(html);
};

// Pages link the sheet with a content-hash query, so a new release gets a new URL and the old one can be cached for good.
const stylesheetRoute: Route = {
  method: 'GET',
  handle: (_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    response.end(STYLESHEET);
  },
};

const redirect = (response: ServerResponse, location: string): void => {
  response.writeHead(303, { location });
  response.end();
};

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'The address contains invalid percent-encoding.');
  }
};

const parseVersion = (value: string | null | undefined): number => {
  if (value == null || !/^[1-9]\d{0,8}$/.test(value)) {
    throw new HttpError(400, 'The version must be a positive integer.');
  }
  return Number(value);
};

const readForm = async (request: IncomingMessage): Promise<URLSearchParams> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'The submitted form is too large.');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
};

const outcomeNotices = (outcome: WriteOutcome): Notice[] => {
  if (outcome.kind === 'failure') return [{ kind: 'error', message: outcome.message, details: outcome.issues }];
  const notices: Notice[] = [{ kind: 'success', message: outcome.message }];
  if (outcome.warning !== undefined) notices.push({ kind: 'warning', message: outcome.warning });
  return notices;
};

const writeStatus = (outcome: WriteOutcome): number => (outcome.kind === 'success' ? 200 : 422);

const BASE_VERSION_MESSAGE = 'The edit form is out of date; reload the page and redo your edit.';
const FIELD_MESSAGE = 'Choose whether to save the enabled flag, the default value or the rules, or to delete the flag.';
const TYPE_MESSAGE = 'Choose whether the new flag is a boolean or a config flag.';

type EditRequest =
  | { readonly ok: true; readonly baseVersion: number; readonly edit: FlagEdit }
  | { readonly ok: false; readonly message: string };

const parseBaseVersion = (fields: URLSearchParams): number | undefined => {
  const baseVersion = fields.get('baseVersion');
  return baseVersion !== null && /^[1-9]\d{0,8}$/.test(baseVersion) ? Number(baseVersion) : undefined;
};

const parseFeatureEdit = (key: string, fields: URLSearchParams): FlagEdit | undefined => {
  switch (fields.get('field')) {
    case 'enabled':
      return { kind: 'enabled', key, enabled: fields.has('enabled') };
    case 'default':
      return { kind: 'default', key, defaultJson: fields.get('default') ?? '' };
    case 'rules':
      return { kind: 'setRules', key, rulesJson: fields.get('rules') ?? '' };
    case 'delete':
      return { kind: 'delete', key };
    default:
      return undefined;
  }
};

const parseEditForm = (key: string, fields: URLSearchParams): EditRequest => {
  const baseVersion = parseBaseVersion(fields);
  if (baseVersion === undefined) return { ok: false, message: BASE_VERSION_MESSAGE };
  const edit = parseFeatureEdit(key, fields);
  return edit === undefined ? { ok: false, message: FIELD_MESSAGE } : { ok: true, baseVersion, edit };
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
  return {
    key,
    enabled: fields.has('enabled'),
    ...(defaultJson === null ? {} : { defaultJson }),
    ...(rulesJson === null ? {} : { rulesJson }),
    message,
    issues,
  };
};

function createDashboardRequestHandler(
  ports: DashboardPorts,
  expectedOrigin: () => string,
  logError: (error: unknown) => void,
): (request: IncomingMessage, response: ServerResponse) => void {
  // Browsers send Origin on every form POST; a request without one is not from this dashboard's pages.
  const isSameOrigin = (request: IncomingMessage): boolean => request.headers.origin === expectedOrigin();

  const editRoute = (
    environment: string,
    parse: (fields: URLSearchParams) => EditRequest,
    draftState: (fields: URLSearchParams, message: string, issues: readonly string[]) => EnvironmentPageState,
  ): Route => ({
    method: 'POST',
    handle: async (request, response) => {
      const fields = await readForm(request);
      const parsed = parse(fields);
      const outcome: WriteOutcome = parsed.ok
        ? await editFeature(ports, environment, parsed.baseVersion, parsed.edit)
        : { kind: 'failure', message: parsed.message, issues: [] };
      const view = await browseEnvironment(ports, environment);
      const state = {
        notices: outcomeNotices(outcome),
        ...(outcome.kind === 'failure' ? draftState(fields, outcome.message, outcome.issues) : {}),
      };
      send(response, writeStatus(outcome), renderEnvironmentPage(view, state));
    },
  });

  const match = (segments: readonly string[]): Route | undefined => {
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
    if (`/${segments.join('/')}` === STYLESHEET_PATH) return stylesheetRoute;
    if (segments[0] !== 'env' || segments.length < 2 || segments.length > 4) return undefined;
    const environment = decodeSegment(segments[1] as string);
    if (segments.length === 2) {
      return {
        method: 'GET',
        handle: async (_request, response) => {
          send(response, 200, renderEnvironmentPage(await browseEnvironment(ports, environment)));
        },
      };
    }
    if (segments.length === 3 && segments[2] === 'publish') {
      return {
        method: 'POST',
        handle: async (request, response) => {
          const draft = (await readForm(request)).get('snapshot') ?? '';
          const outcome = await publishSnapshot(ports, environment, draft);
          const view = await browseEnvironment(ports, environment);
          const state = {
            notices: outcomeNotices(outcome),
            ...(outcome.kind === 'failure' ? { draft } : {}),
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
          send(response, writeStatus(outcome), renderEnvironmentPage(view, { notices: outcomeNotices(outcome) }));
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
        (fields) => parseEditForm(key, fields),
        (fields, message, issues) => ({ editDraft: editDraftOf(key, fields, message, issues) }),
      );
    }
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
    const route = match(segments);
    if (route === undefined) throw new HttpError(404, 'There is no page at this address.');
    if (route.method !== request.method) {
      response.setHeader('allow', route.method);
      throw new HttpError(405, 'This address does not accept that request method.');
    }
    if (route.method === 'POST' && !isSameOrigin(request)) {
      throw new HttpError(403, 'Changes are only accepted from this dashboard’s own pages.');
    }
    await route.handle(request, response, url);
  };

  return (request, response) => {
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
  let origin = '';
  const handler = createDashboardRequestHandler(
    options.ports,
    () => origin,
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
  const { port } = server.address() as AddressInfo;
  origin = `http://${LOOPBACK_HOST}:${String(port)}`;
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
