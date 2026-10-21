// mcpbench leaderboard: run picker and sortable tables. The latest run is already rendered
// into the page by scripts/build-site.mjs; this only adds interaction.
import { renderFooter, renderRun } from './render.js';

const data = JSON.parse(document.getElementById('mcpbench-data').textContent);
const byId = new Map(data.index.map((r) => [r.runId, r]));
const picker = document.getElementById('run-picker');
const view = document.getElementById('run-view');
const footer = document.querySelector('#run-footer .wrap');
const status = document.getElementById('sort-status');

function runFromHash() {
  const m = /^#run=(.+)$/.exec(location.hash);
  const id = m ? decodeURIComponent(m[1]) : null;
  return id && byId.has(id) && data.results[id] ? id : null;
}

function show(runId) {
  const results = data.results[runId];
  if (!results) return;
  view.innerHTML = renderRun(results, byId.get(runId));
  footer.innerHTML = renderFooter(results);
  picker.value = runId;
  enhance(view);
}

// ---- sorting ----

function sortValue(row, index, type) {
  const cell = row.children[index];
  const raw = cell ? cell.getAttribute('data-v') ?? cell.textContent.trim() : '';
  if (raw === '') return null;
  if (type === 'num') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return raw.toLowerCase();
}

function sortTable(table, th, direction) {
  const index = [...th.parentElement.children].indexOf(th);
  const type = th.dataset.sort;
  const tbody = table.tBodies[0];
  const rows = [...tbody.rows].map((row, i) => ({ row, i, v: sortValue(row, index, type) }));
  const sign = direction === 'ascending' ? 1 : -1;
  rows.sort((a, b) => {
    if (a.v === null && b.v === null) return a.i - b.i;
    if (a.v === null) return 1; // missing values last, whichever the direction
    if (b.v === null) return -1;
    const d = type === 'num' ? a.v - b.v : a.v.localeCompare(b.v);
    return d !== 0 ? sign * d : a.i - b.i;
  });
  for (const { row } of rows) tbody.appendChild(row);
  for (const other of th.parentElement.children) if (other !== th) other.removeAttribute('aria-sort');
  th.setAttribute('aria-sort', direction);
  status.textContent = `Sorted by ${th.querySelector('button').textContent.trim()}, ${direction}.`;
}

function enhance(root) {
  for (const table of root.querySelectorAll('table[data-sortable]')) {
    for (const th of table.tHead.rows[0].cells) {
      if (!th.dataset.sort || th.querySelector('button')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort';
      while (th.firstChild) button.appendChild(th.firstChild);
      const icon = document.createElement('span');
      icon.className = 'sort-icon';
      icon.setAttribute('aria-hidden', 'true');
      button.insertBefore(icon, button.querySelector('.sub')); // after the label, before its unit line
      th.appendChild(button);
      button.addEventListener('click', () => {
        const current = th.getAttribute('aria-sort');
        // Numbers start highest first, text A to Z; a second click flips it.
        const first = th.dataset.sort === 'num' ? 'descending' : 'ascending';
        const next = current === 'ascending' ? 'descending' : current === 'descending' ? 'ascending' : first;
        sortTable(table, th, next);
      });
    }
  }
}

picker.addEventListener('change', () => {
  show(picker.value);
  history.replaceState(null, '', picker.value === data.latestRunId ? location.pathname + location.search : `#run=${encodeURIComponent(picker.value)}`);
});
window.addEventListener('hashchange', () => {
  const id = runFromHash();
  if (id) show(id);
});

const initial = runFromHash();
if (initial && initial !== view.querySelector('[data-run]')?.getAttribute('data-run')) show(initial);
else enhance(view);
