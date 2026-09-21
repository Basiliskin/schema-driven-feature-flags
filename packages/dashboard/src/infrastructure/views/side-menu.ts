import { withUrlState, type DashboardUrlState } from '../url-state.js';
import { environmentPath, escapeHtml } from './escape.js';

/** Which of the environment-scoped views is being rendered; the route is the selector, not a query key. */
export type SideMenuView = 'flags' | 'versions' | 'segments';

interface MenuItem {
  readonly view: SideMenuView;
  readonly label: string;
  readonly path: (environment: string) => string;
}

const ITEMS: readonly MenuItem[] = [
  { view: 'flags', label: 'Flags', path: environmentPath },
  { view: 'versions', label: 'Versions', path: (environment) => `${environmentPath(environment)}/versions` },
  { view: 'segments', label: 'Segments', path: (environment) => `${environmentPath(environment)}/segments` },
];

const renderItem = (environment: string, current: SideMenuView, urlState: DashboardUrlState, item: MenuItem): string => {
  const active = item.view === current;
  const href = withUrlState(item.path(environment), urlState);
  return `<a href="${escapeHtml(href)}" class="side-menu-item${active ? ' is-current' : ''}"${active ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`;
};

/**
 * The persistent left-hand menu over the three environment-scoped views. Every href carries the current
 * filter, open rows and paging, so moving between views and back does not reset what the operator built.
 */
export const renderSideMenu = (environment: string, current: SideMenuView, urlState: DashboardUrlState): string =>
  `<nav class="side-menu" aria-label="Views">${ITEMS.map((item) => renderItem(environment, current, urlState, item)).join('')}</nav>`;
