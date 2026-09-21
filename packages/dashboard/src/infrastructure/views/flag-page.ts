import type { EnvironmentView, FlagDefinitionView } from '../../application/browse-environment.js';
import type { PublishedSegmentsView } from '../../application/list-published-segments.js';
import { NO_URL_STATE } from '../url-state.js';
import { environmentPath, escapeHtml } from './escape.js';
import { renderFeatureEditForm } from './feature-edit-form.js';
import { renderPage } from './layout.js';

interface CurrentFlag {
  readonly flag: FlagDefinitionView;
  readonly currentVersion: number;
}

const findCurrentFlag = (view: EnvironmentView, key: string): CurrentFlag | undefined => {
  if (view.status !== 'published' || view.current.status !== 'available' || view.current.contents.status !== 'valid') {
    return undefined;
  }
  const flag = view.current.contents.flags.find((candidate) => candidate.key === key);
  return flag === undefined ? undefined : { flag, currentVersion: view.currentVersion };
};

/** `undefined` when the environment has no valid current snapshot or does not define the key, so the route can answer 404. */
export const renderFlagPage = (
  view: EnvironmentView,
  key: string,
  publishedSegments: PublishedSegmentsView,
): string | undefined => {
  const found = findCurrentFlag(view, key);
  if (found === undefined) return undefined;
  const heading = `${view.environment} · ${key}`;
  return renderPage(
    heading,
    `<p><a class="back-link" href="${escapeHtml(environmentPath(view.environment))}">Back to ${escapeHtml(view.environment)}</a></p>
<div class="page-head"><div><p class="eyebrow">Flag</p><h1>${escapeHtml(key)}</h1></div></div>
<section class="card">
${renderFeatureEditForm(found.flag, {
      environment: view.environment,
      baseVersion: found.currentVersion,
      // The single-flag page has no flag list to filter and no sibling rows to open, so it carries no URL state.
      urlState: NO_URL_STATE,
      publishedSegments,
    })}
</section>`,
  );
};
