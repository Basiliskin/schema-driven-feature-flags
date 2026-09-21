import { withUrlState, type DashboardUrlState } from '../url-state.js';
import { environmentPath, escapeHtml } from './escape.js';

/** A section of the environment page, named by the heading id already rendered there. */
export interface SectionLink {
  readonly fragment: string;
  readonly label: string;
}

export const CURRENT_SECTION: SectionLink = { fragment: 'current-heading', label: 'Current snapshot' };
export const FLAGS_SECTION: SectionLink = { fragment: 'flags-heading', label: 'Flags' };
export const VERSIONS_SECTION: SectionLink = { fragment: 'versions-heading', label: 'Version history' };

const renderLink = (environment: string, urlState: DashboardUrlState, { fragment, label }: SectionLink): string =>
  `<a href="${escapeHtml(`${withUrlState(environmentPath(environment), urlState)}#${fragment}`)}">${escapeHtml(label)}</a>`;

/**
 * A strip of in-page links that stays pinned while the environment page scrolls. Each href carries the
 * current filter and open rows, so jumping between sections does not reset the view the operator built.
 */
export const renderSectionNav = (environment: string, urlState: DashboardUrlState, sections: readonly SectionLink[]): string =>
  `<nav class="section-nav" aria-label="Sections">${sections.map((section) => renderLink(environment, urlState, section)).join('')}</nav>`;
