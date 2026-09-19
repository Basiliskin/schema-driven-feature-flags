import { renderPage } from './layout.js';

export const renderErrorPage = (title: string, message: string): string =>
  renderPage(title, '<h1>Something went wrong</h1>', [{ kind: 'error', message }]);
