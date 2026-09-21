import { DEFAULT_VERSION_PAGE_SIZE } from '../application/list-version-page.js';
import { HttpError } from './http-primitives.js';

/** Caps on the query-string values an operator — or an attacker crafting a link — can put in front of the renderer. */
export const MAX_FILTER_LENGTH = 100;
export const MAX_OPEN_KEY_LENGTH = 120;
export const MAX_OPEN_KEYS = 20;

export const DEFAULT_PAGE = 1;
export const PAGE_MESSAGE = 'The page must be a positive integer.';
export const PAGE_SIZE_MESSAGE = 'The page size must be a positive integer.';

/** The dashboard's whole query-string vocabulary: 'filter', 'open', 'page', 'pageSize'. There is no flag-list paging key. */
export interface DashboardUrlState {
  readonly filter: string;
  readonly openFlags: readonly string[];
  readonly page: number;
  readonly pageSize: number;
}

const PAGE_PATTERN = /^[1-9]\d{0,8}$/;

/** A page number or size from the query string; absent falls back, anything else is a tampered or mistyped URL. */
export const parsePageNumber = (value: string | null, fallback: number, message: string): number => {
  if (value === null) return fallback;
  if (!PAGE_PATTERN.test(value)) throw new HttpError(400, message);
  return Number(value);
};

const parseFilter = (value: string | null): string => (value ?? '').trim().slice(0, MAX_FILTER_LENGTH).trim();

const parseOpenFlags = (value: string | null): string[] => {
  const keys = new Set<string>();
  for (const entry of (value ?? '').split(',')) {
    const key = entry.trim();
    if (key === '' || key.length > MAX_OPEN_KEY_LENGTH) continue;
    keys.add(key);
    if (keys.size === MAX_OPEN_KEYS) break;
  }
  return [...keys];
};

/** A page or size arriving in a form body rather than a URL: a tampered value falls back instead of turning a rejected write into a 400. */
const parsePageOrDefault = (value: string | null, fallback: number): number =>
  value !== null && PAGE_PATTERN.test(value) ? Number(value) : fallback;

export const parseUrlState = (params: URLSearchParams): DashboardUrlState => ({
  filter: parseFilter(params.get('filter')),
  openFlags: parseOpenFlags(params.get('open')),
  page: parsePageNumber(params.get('page'), DEFAULT_PAGE, PAGE_MESSAGE),
  pageSize: parsePageNumber(params.get('pageSize'), DEFAULT_VERSION_PAGE_SIZE, PAGE_SIZE_MESSAGE),
});

export const serialiseUrlState = (state: Partial<DashboardUrlState>): string => {
  const params = new URLSearchParams();
  const filter = state.filter ?? '';
  const openFlags = state.openFlags ?? [];
  const page = state.page ?? DEFAULT_PAGE;
  const pageSize = state.pageSize ?? DEFAULT_VERSION_PAGE_SIZE;
  if (filter !== '') params.set('filter', filter);
  if (openFlags.length > 0) params.set('open', openFlags.join(','));
  if (page !== DEFAULT_PAGE) params.set('page', String(page));
  if (pageSize !== DEFAULT_VERSION_PAGE_SIZE) params.set('pageSize', String(pageSize));
  // URLSearchParams spells a space '+'; '%20' means the same thing in a query and reads the same in an href.
  return params.toString().replace(/\+/g, '%20');
};

export const withUrlState = (path: string, state: Partial<DashboardUrlState>): string => {
  const query = serialiseUrlState(state);
  return query === '' ? path : `${path}?${query}`;
};

/**
 * The same state arriving as hidden fields of a write form. Write POSTs re-render the page in place, so the
 * fields are the only way the view survives a submit — and they are as client-supplied as the query string,
 * hence the same caps. A bad page value falls back rather than throwing, so a hand-edited field cannot turn
 * a 422 rejection into a 400 error page and lose the operator's draft.
 */
export const parseUrlStateFields = (fields: URLSearchParams): DashboardUrlState => ({
  filter: parseFilter(fields.get('filter')),
  openFlags: parseOpenFlags(fields.get('open')),
  page: parsePageOrDefault(fields.get('page'), DEFAULT_PAGE),
  pageSize: parsePageOrDefault(fields.get('pageSize'), DEFAULT_VERSION_PAGE_SIZE),
});

/** The state of a page asked for without any query string, for the pages outside the URL-State contract. */
export const NO_URL_STATE: DashboardUrlState = parseUrlState(new URLSearchParams());
