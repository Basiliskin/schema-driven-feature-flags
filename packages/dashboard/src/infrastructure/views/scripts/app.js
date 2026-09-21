// Progressive enhancement for the dashboard pages. Everything here is optional: without JavaScript the
// pages still work, they just lack copy buttons, the publish dialog, the flag filter and update checks.
(function () {
  'use strict';

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    var source = document.getElementById(button.getAttribute('data-copy'));
    if (!source || !navigator.clipboard) return;
    button.hidden = false;
    button.addEventListener('click', function () {
      navigator.clipboard.writeText(source.textContent).then(function () {
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = 'Copy JSON'; }, 1500);
      });
    });
  });

  document.querySelectorAll('dialog').forEach(function (dialog) {
    if (typeof dialog.showModal !== 'function') return;
    dialog.classList.add('is-enhanced');
    if (dialog.hasAttribute('data-open-on-load')) dialog.showModal();
  });

  document.querySelectorAll('[data-open-dialog]').forEach(function (button) {
    var dialog = document.getElementById(button.getAttribute('data-open-dialog'));
    if (!dialog || !dialog.classList.contains('is-enhanced')) return;
    button.hidden = false;
    button.addEventListener('click', function () { dialog.showModal(); });
  });

  document.querySelectorAll('[data-filter]').forEach(function (input) {
    var list = document.querySelector('.' + input.getAttribute('data-filter'));
    if (!list) return;
    var empty = list.parentNode.querySelector('[data-filter-empty]');
    input.addEventListener('input', function () {
      var terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      var shown = 0;
      list.querySelectorAll('[data-search]').forEach(function (item) {
        var text = item.getAttribute('data-search');
        var match = terms.every(function (term) { return text.indexOf(term) !== -1; });
        item.hidden = !match;
        if (match) shown++;
      });
      if (empty) empty.hidden = shown !== 0;
    });
  });

  // The CSV never becomes a multipart upload: it is read here and submitted as an ordinary form field.
  document.querySelectorAll('[data-segment-upload]').forEach(function (form) {
    var file = form.querySelector('[data-segment-file]');
    var csv = form.querySelector('[name="csv"]');
    if (!file || !csv || typeof FileReader !== 'function') return;
    form.addEventListener('submit', function (event) {
      if (csv.value !== '' || !file.files || file.files.length === 0) return;
      event.preventDefault();
      var reader = new FileReader();
      reader.addEventListener('load', function () {
        csv.value = String(reader.result);
        form.submit();
      });
      reader.readAsText(file.files[0]);
    });
  });

  // ---- Update checks and merge ----
  var watch = document.querySelector('[data-watch-version]');
  if (!watch || !window.fetch) return;
  var base = Number(watch.getAttribute('data-watch-version'));
  var envPath = watch.getAttribute('data-watch-path');
  var banner = document.getElementById('update-banner');
  var changesDialog = document.getElementById('changes-dialog');
  var changesBody = document.getElementById('changes-body');
  var storageKey = 'featuresync:carried-edits:' + envPath;
  var latest = base;
  // Set when the server rejected an edit because someone published first: the page is already at the
  // latest version with that edit in its form, and the review compares against the version it was made on.
  var reviewSince = watch.getAttribute('data-review-since');
  var reviewKey = watch.getAttribute('data-review-key');
  var inConflict = function () { return reviewSince !== null && latest === base; };

  // An edit is any control whose value differs from what the server rendered.
  var isDirty = function (field) {
    if (field.type === 'checkbox') return field.checked !== field.defaultChecked;
    if (field.tagName === 'SELECT') return !field.options[field.selectedIndex].defaultSelected;
    return field.value !== field.defaultValue;
  };

  var collectEdits = function () {
    var edits = [];
    document.querySelectorAll('[data-flag] input[name], [data-flag] textarea[name], #publish-dialog textarea[name]').forEach(function (field) {
      if (field.type === 'hidden' || !isDirty(field)) return;
      var row = field.closest('[data-flag]');
      edits.push({
        flag: row ? row.getAttribute('data-flag') : '',
        name: field.name,
        value: field.type === 'checkbox' ? field.checked : field.value,
      });
    });
    var create = document.querySelector('form[action$="/features"]');
    if (create) {
      create.querySelectorAll('input[name], select[name], textarea[name]').forEach(function (field) {
        if (field.type === 'hidden' || !isDirty(field)) return;
        edits.push({ flag: '+new', name: field.name, value: field.type === 'checkbox' ? field.checked : field.value });
      });
    }
    return edits;
  };

  var showBanner = function (version) {
    latest = version;
    banner.querySelector('[data-latest-version]').textContent = String(version);
    banner.hidden = false;
    document.title = '● ' + document.title.replace(/^● /, '');
  };

  var check = function () {
    fetch(envPath + '/current-version', { cache: 'no-store' })
      .then(function (reply) { return reply.ok ? reply.json() : null; })
      .then(function (body) {
        if (body && typeof body.version === 'number' && body.version !== base && body.version !== latest) showBanner(body.version);
      })
      .catch(function () { /* offline or restarting; try again on the next tick */ });
  };

  var markConflicts = function () {
    var edits = collectEdits();
    var editedFlags = {};
    edits.forEach(function (edit) { editedFlags[edit.flag] = true; });
    var conflicts = 0;
    changesBody.querySelectorAll('[data-changed-key]').forEach(function (item) {
      if (item.querySelector('[data-rejected-edit]')) { conflicts++; return; }
      var conflict = editedFlags[item.getAttribute('data-changed-key')] === true;
      item.querySelector('[data-conflict-note]').hidden = !conflict;
      item.classList.toggle('has-conflict', conflict);
      if (conflict) conflicts++;
    });
    var keep = changesBody.querySelector('[data-merge="keep"]');
    var hint = changesBody.querySelector('[data-merge-hint]');
    var discard = changesBody.querySelector('[data-merge="discard"]');
    if (inConflict()) {
      var row = document.querySelector('[data-flag="' + CSS.escape(reviewKey) + '"]');
      discard.textContent = 'Discard my edit';
      keep.textContent = 'Keep my edit and review it';
      keep.hidden = !row;
      hint.textContent = row
        ? 'Your edit is already applied on top of version ' + base + ' in the flag’s form; it is not saved until you save it again.'
        : 'The flag you edited no longer exists in version ' + base + '.';
      return;
    }
    if (edits.length === 0) {
      keep.hidden = true;
      hint.hidden = true;
      changesBody.querySelector('[data-merge="discard"]').textContent = 'Load latest';
    } else if (conflicts > 0) {
      hint.textContent = conflicts + (conflicts === 1 ? ' flag has' : ' flags have') +
        ' both your unsaved edits and newer changes. Keeping your edits puts them over the latest values — check those rows before saving.';
    }
  };

  // A rejected pasted snapshot is merged, not just listed: its draft is sent along for a three-way merge.
  var isDraftMerge = function () { return inConflict() && !reviewKey; };
  var draftField = document.getElementById('snapshot');

  var openMerge = function () {
    changesDialog.querySelector('#changes-heading').textContent = 'Merge your draft';
    var body = new URLSearchParams({ since: reviewSince, snapshot: draftField.value });
    fetch(envPath + '/merge', { method: 'POST', body: body, cache: 'no-store' })
      .then(function (reply) { return reply.text(); })
      .then(function (html) { changesBody.innerHTML = html; })
      .catch(function () {
        changesBody.innerHTML = '<p class="notice error">The merge could not be loaded. Reload the page to see the latest version.</p>';
      });
  };

  var checkedIn = function (scope) {
    var chosen = scope.querySelector(':scope > .merge-choice input[type="radio"]:checked');
    return chosen ? chosen.value : undefined;
  };

  // Sends only the operator's choices; the server recomputes the merge and builds the merged draft,
  // so the merge rules live in one tested place.
  var applyMerge = function () {
    var form = changesBody.querySelector('[data-merge-form]');
    var choices = {};
    form.querySelectorAll('[data-merge-key]').forEach(function (item) {
      var key = item.getAttribute('data-merge-key');
      if (!item.hasAttribute('data-by-field')) {
        var side = checkedIn(item);
        if (side) choices[key] = side;
        return;
      }
      var fields = {};
      item.querySelectorAll('[data-merge-field]').forEach(function (row) {
        var fieldSide = checkedIn(row);
        if (fieldSide) fields[row.getAttribute('data-merge-field')] = fieldSide;
      });
      choices[key] = fields;
    });
    var body = new URLSearchParams({
      since: reviewSince,
      to: form.getAttribute('data-to'),
      snapshot: draftField.value,
      choices: JSON.stringify(choices),
    });
    var problem = form.querySelector('[data-merge-missing]');
    fetch(envPath + '/merge/apply', { method: 'POST', body: body, cache: 'no-store' })
      .then(function (reply) { return reply.json(); })
      .then(function (result) {
        form.querySelectorAll('.is-missing').forEach(function (node) { node.classList.remove('is-missing'); });
        if (result.status === 'merged') {
          draftField.value = result.snapshotText;
          draftField.classList.add('is-carried');
          changesDialog.close();
          document.getElementById('publish-dialog').showModal();
          return;
        }
        if (result.status === 'missing') {
          result.missing.forEach(function (name) {
            var dot = name.indexOf('.');
            var item = form.querySelector('[data-merge-key="' + CSS.escape(dot === -1 ? name : name.slice(0, dot)) + '"]');
            var target = dot === -1 ? item : item && item.querySelector('[data-merge-field="' + CSS.escape(name.slice(dot + 1)) + '"]');
            if (target) target.classList.add('is-missing');
          });
          problem.textContent = 'Choose a side for every conflict first.';
        } else if (result.status === 'moved') {
          // Reopening the review merges against the new latest version.
          problem.textContent = 'Version ' + result.to + ' was published while you were merging. Close this and review changes again to merge it too.';
        } else {
          problem.textContent = 'The draft could not be merged. Go back to it and check it is valid JSON.';
        }
        problem.hidden = false;
      })
      .catch(function () {
        problem.textContent = 'The merge could not be applied. Try again.';
        problem.hidden = false;
      });
  };

  var openChanges = function () {
    changesBody.innerHTML = '<p class="muted">Loading changes…</p>';
    changesDialog.showModal();
    if (isDraftMerge()) { openMerge(); return; }
    var since = reviewSince !== null ? reviewSince : String(base);
    var edited = reviewKey ? '&edited=' + encodeURIComponent(reviewKey) : '';
    fetch(envPath + '/changes?since=' + since + edited, { cache: 'no-store' })
      .then(function (reply) { return reply.text(); })
      .then(function (html) {
        changesBody.innerHTML = html;
        markConflicts();
      })
      .catch(function () {
        changesBody.innerHTML = '<p class="notice error">The changes could not be loaded. Reload the page to see the latest version.</p>';
      });
  };

  changesBody.addEventListener('click', function (event) {
    var button = event.target.closest('[data-merge]');
    if (!button) return;
    var action = button.getAttribute('data-merge');
    if (action === 'apply') { applyMerge(); return; }
    if (isDraftMerge() && action === 'keep') {
      changesDialog.close();
      document.getElementById('publish-dialog').showModal();
      return;
    }
    if (inConflict() && action === 'keep') {
      changesDialog.close();
      var row = document.querySelector('[data-flag="' + CSS.escape(reviewKey) + '"]');
      row.querySelector('details').open = true;
      row.scrollIntoView({ block: 'center' });
      return;
    }
    if (action === 'keep') {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify({ from: base, edits: collectEdits() }));
      } catch { /* storage blocked: the edits can't be carried, so this degrades to a plain reload */ }
    }
    window.location.assign(envPath);
  });

  banner.querySelector('[data-review-changes]').addEventListener('click', openChanges);

  // Re-apply edits carried over from the previous render, opening each touched row so they're visible.
  var restore = function () {
    var saved;
    try {
      saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      sessionStorage.removeItem(storageKey);
    } catch { return; }
    if (!saved || !saved.edits || saved.edits.length === 0) return;
    var lost = [];
    saved.edits.forEach(function (edit) {
      var scope = edit.flag === '' ? document.getElementById('publish-dialog')
        : edit.flag === '+new' ? document.querySelector('form[action$="/features"]')
        : document.querySelector('[data-flag="' + CSS.escape(edit.flag) + '"]');
      var field = scope && scope.querySelector('[name="' + CSS.escape(edit.name) + '"]:not([type="hidden"])');
      if (!field) { lost.push(edit.flag || 'publish draft'); return; }
      if (field.type === 'checkbox') field.checked = edit.value; else field.value = edit.value;
      field.classList.add('is-carried');
      var details = field.closest('details');
      while (details) { details.open = true; details = details.parentElement.closest('details'); }
    });
    var note = document.getElementById('merge-notice');
    note.querySelector('p').textContent = lost.length === 0
      ? 'Your unsaved edits were reapplied on top of version ' + base + '. Highlighted fields are not saved yet.'
      : 'Your edits were reapplied on top of version ' + base + ', except for flags that no longer exist: ' + lost.join(', ') + '.';
    note.hidden = false;
  };

  restore();
  setInterval(function () { if (!document.hidden) check(); }, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
})();
