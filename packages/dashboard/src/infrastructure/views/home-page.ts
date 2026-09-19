import { renderPage } from './layout.js';

export const renderHomePage = (): string =>
  renderPage(
    'Environments',
    `<div class="page-head"><h1>Pick an environment</h1></div>
<section class="card">
<form method="get" action="/" class="form-row">
<label>Environment <input name="env" required></label>
<button type="submit">Open</button>
</form>
</section>`,
  );
