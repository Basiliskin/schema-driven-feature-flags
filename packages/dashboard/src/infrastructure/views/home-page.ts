import { renderPage } from './layout.js';

export const renderHomePage = (): string =>
  renderPage(
    'Environments',
    `<h1>Pick an environment</h1>
<form method="get" action="/">
<label>Environment <input name="env" required></label>
<button type="submit">Open</button>
</form>`,
  );
