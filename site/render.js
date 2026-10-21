// Shared renderer for the mcpbench leaderboard. Plain ES module with no dependencies:
// scripts/build-site.mjs imports it to pre-render the latest run into index.html, and
// app.js imports it in the browser to re-render when another run is picked.

export const REPO_URL = 'https://github.com/HITMANdark07/mcp-evals';
export const METHODOLOGY_URL = `${REPO_URL}/blob/main/docs/methodology.md`;
export const SUITES_URL = `${REPO_URL}/tree/main/suites`;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

// ---- number formatting (same conventions as the CLI's `report`) ----
export const pct = (x) => `${Math.round(x * 100)}%`;
export const ci = ([lo, hi]) => `[${Math.round(lo * 100)}–${Math.round(hi * 100)}%]`;
export const usd = (x) => `$${x.toFixed(4)}`;
export const usd2 = (x) => `$${x.toFixed(2)}`;
export const int = (x) => Math.round(x).toLocaleString('en-US');
export const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
export const steps = (x) => x.toFixed(1);
export const shortCommit = (c) => (c ? String(c).slice(0, 12) : null);
/** "2026-10-16 11:09 UTC" from an ISO timestamp, identical in Node and every browser. */
export const utc = (iso) => (typeof iso === 'string' && iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : esc(iso));
export const bytes = (n) => (n == null ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const cellKey = (c) => `${c.server}|${c.model}`;
export const isIncomplete = (c) => c.plannedRuns !== null && c.plannedRuns !== undefined && !c.complete;
export const runsText = (c) => (c.plannedRuns == null ? String(c.runs) : `${c.runs}/${c.plannedRuns}`);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const taskErrors = (c) => c.tasks.reduce((n, t) => n + t.errors, 0);
/** Repeats per task, read from the per-task counts (the largest pass+fail+error total). */
export const repeatsOf = (results) => {
  let max = 0;
  for (const s of results.suites) for (const c of s.cells) for (const t of c.tasks) max = Math.max(max, t.passes + t.fails + t.errors);
  return max;
};
export const totalRuns = (results) => results.suites.reduce((n, s) => n + s.cells.reduce((m, c) => m + c.runs, 0), 0);

/** Cells ordered by model, then server, so each model's servers sit next to each other. */
function orderedCells(suite) {
  const modelRank = new Map(suite.models.map((m, i) => [m.id, i]));
  const serverRank = new Map(Object.keys(suite.servers).map((s, i) => [s, i]));
  const rank = (map, k) => (map.has(k) ? map.get(k) : Number.MAX_SAFE_INTEGER);
  return suite.cells
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(modelRank, a.c.model) - rank(modelRank, b.c.model) || rank(serverRank, a.c.server) - rank(serverRank, b.c.server) || a.i - b.i)
    .map((x) => x.c);
}

const linkIfHttps = (url, text) => (/^https:\/\//.test(url) ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));

function fixtureText(fixture) {
  if (!fixture) return null;
  const name = fixture.git.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const ref = /^[0-9a-f]{40}$/.test(fixture.ref) ? fixture.ref.slice(0, 7) : fixture.ref;
  const url = /^https:\/\/github\.com\//.test(fixture.git) ? `${fixture.git.replace(/\.git$/, '')}/tree/${fixture.ref}` : fixture.git;
  return `${linkIfHttps(url, name)} @ <code>${esc(ref)}</code>`;
}

// ---- the cells table ----

/** Columns: label, sort type, cell renderer → [html, sortValue]. */
function columns(suite) {
  const providerOf = new Map(suite.models.map((m) => [m.id, m.provider]));
  const cols = [
    {
      id: 'success', label: 'Success', sub: '95% CI', sort: 'num',
      td: (c) => {
        if (c.successRate === null) return ['<span class="na">–</span>', ''];
        const [lo, hi] = c.successCi95;
        const bar =
          `<span class="bar" aria-hidden="true"><span class="bar-ci" style="left:${(lo * 100).toFixed(1)}%;width:${((hi - lo) * 100).toFixed(1)}%"></span>` +
          `<span class="bar-pt" style="left:${(c.successRate * 100).toFixed(1)}%"></span></span>`;
        return [`<span class="num">${pct(c.successRate)}</span> <span class="ci">${ci(c.successCi95)}</span>${bar}`, c.successRate];
      },
    },
    { id: 'success-err', label: 'Success', sub: 'errors as fails', sort: 'num', td: (c) => (c.successRateWithErrors == null ? ['<span class="na">–</span>', ''] : [pct(c.successRateWithErrors), c.successRateWithErrors]) },
    { id: 'invalid', label: 'Invalid tool calls', sort: 'num', td: (c) => (c.invalidToolCallRate == null ? ['<span class="na">–</span>', ''] : [pct(c.invalidToolCallRate), c.invalidToolCallRate]) },
  ];
  if (suite.cells.some((c) => c.toolAccuracy !== null)) {
    cols.push({ id: 'tool-acc', label: 'Tool accuracy', sort: 'num', td: (c) => (c.toolAccuracy === null ? ['<span class="na">–</span>', ''] : [pct(c.toolAccuracy), c.toolAccuracy]) });
  }
  cols.push(
    { id: 'ctx', label: 'Context tokens', sub: 'median', sort: 'num', td: (c) => [int(c.contextTokensPerTask.median), c.contextTokensPerTask.median] },
    { id: 'prompt', label: 'Provider prompt tokens', sub: 'median', sort: 'num', td: (c) => (c.providerPromptTokensPerTask ? [int(c.providerPromptTokensPerTask.median), c.providerPromptTokensPerTask.median] : ['<span class="na">–</span>', '']) },
    { id: 'steps', label: 'Steps', sub: 'mean', sort: 'num', td: (c) => [steps(c.stepsPerTask), c.stepsPerTask] },
    { id: 'latency', label: 'Latency', sub: 'p50', sort: 'num', td: (c) => [seconds(c.latencyMsP50), c.latencyMsP50] },
    { id: 'cost', label: '$/task', sort: 'num', td: (c) => [usd(c.costUsdPerTask), c.costUsdPerTask] },
    {
      id: 'runs', label: 'Runs', sub: 'done/planned', sort: 'num',
      td: (c) => {
        const errs = taskErrors(c);
        let html = runsText(c);
        if (errs > 0) html += ` <span class="note">${errs} error${errs === 1 ? '' : 's'}</span>`;
        if (isIncomplete(c)) html += ' <span class="badge badge-warn">incomplete</span>';
        else if (c.plannedRuns == null) html += ' <span class="badge">planned unknown</span>';
        return [html, c.plannedRuns ? c.runs / c.plannedRuns : c.runs];
      },
    },
  );
  return { cols, providerOf };
}

function cellsTable(suite, idBase) {
  const { cols, providerOf } = columns(suite);
  const capId = `${idBase}-cap`;
  const head =
    `<th scope="col" class="col-cell" data-sort="text">Server · model</th>` +
    cols.map((col) => `<th scope="col" data-sort="${col.sort}" data-col="${col.id}">${esc(col.label)}${col.sub ? ` <span class="sub">${esc(col.sub)}</span>` : ''}</th>`).join('');
  const rows = orderedCells(suite)
    .map((c) => {
      const provider = providerOf.get(c.model);
      const label =
        `<th scope="row" class="col-cell" data-v="${esc(`${c.server} ${c.model}`)}"><span class="server">${esc(c.server)}</span>` +
        `<span class="model">${esc(c.model)}</span>${provider ? `<span class="provider">via ${esc(provider)}</span>` : ''}</th>`;
      const tds = cols.map((col) => {
        const [html, v] = col.td(c);
        return `<td data-col="${col.id}" data-v="${esc(v)}">${html}</td>`;
      });
      return `<tr data-cell="${esc(cellKey(c))}"${isIncomplete(c) ? ' class="row-incomplete"' : ''}>${label}${tds.join('')}</tr>`;
    })
    .join('\n');
  return (
    `<div class="table-wrap" role="region" aria-labelledby="${capId}" tabindex="0">` +
    `<table class="cells" data-sortable>` +
    `<caption id="${capId}">${esc(suite.suite)}: one row per server × model cell</caption>` +
    `<thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>`
  );
}

// ---- the per-task breakdown ----

function tasksTable(suite, idBase) {
  const cells = orderedCells(suite);
  const taskIds = [];
  for (const c of cells) for (const t of c.tasks) if (!taskIds.includes(t.id)) taskIds.push(t.id);
  const byCell = cells.map((c) => new Map(c.tasks.map((t) => [t.id, t])));
  const capId = `${idBase}-tasks-cap`;
  const head =
    '<th scope="col">Task</th>' +
    cells.map((c) => `<th scope="col"><span class="server">${esc(c.server)}</span><span class="model">${esc(c.model.replace(/^[^/]+\//, ''))}</span></th>`).join('');
  const countCell = (t) => {
    if (!t) return '<td class="na">–</td>';
    const total = t.passes + t.fails + t.errors;
    const f = total > 0 ? t.passes / total : 0;
    const style = f > 0 ? ` style="--pass-mix:${Math.round(10 + f * 26)}%"` : '';
    const err = t.errors > 0 ? ` <span class="note">${t.errors} err</span>` : '';
    return `<td class="${f > 0 ? 'tint' : 'zero'}"${style}>${t.passes}/${total}${err}</td>`;
  };
  const rows = taskIds.map((id) => `<tr><th scope="row"><code>${esc(id)}</code></th>${byCell.map((m) => countCell(m.get(id))).join('')}</tr>`);
  const totals = cells.map((c) => {
    const p = c.tasks.reduce((n, t) => n + t.passes, 0);
    const n = c.tasks.reduce((s, t) => s + t.passes + t.fails + t.errors, 0);
    return `<td>${p}/${n}</td>`;
  });
  rows.push(`<tr class="row-total"><th scope="row">All tasks</th>${totals.join('')}</tr>`);
  return (
    `<details class="tasks"><summary>Per-task breakdown <span class="sub">${taskIds.length} tasks × ${cells.length} cells, passes / runs</span></summary>` +
    `<div class="table-wrap" role="region" aria-labelledby="${capId}" tabindex="0"><table class="task-grid">` +
    `<caption id="${capId}">${esc(suite.suite)}: passes per task and cell (passes / runs; errors noted)</caption>` +
    `<thead><tr>${head}</tr></thead><tbody>\n${rows.join('\n')}\n</tbody></table></div></details>`
  );
}

function suiteSection(results, suite, si) {
  const idBase = `s-${slug(results.runId)}-${si}-${slug(suite.suite)}`;
  const servers = Object.entries(suite.servers)
    .map(([name, s]) => `${esc(name)}${s.version ? ` <code>${esc(s.version)}</code>` : ''}`)
    .join(', ');
  const taskCount = new Set(suite.cells.flatMap((c) => c.tasks.map((t) => t.id))).size;
  const meta = [`${taskCount} tasks`, `servers: ${servers}`];
  const fx = fixtureText(suite.fixture);
  if (fx) meta.push(`fixture ${fx}`);
  if (suite.judge) meta.push(`judge <code>${esc(suite.judge.id)}</code> via ${esc(suite.judge.provider)}`);
  const incomplete = suite.cells.filter(isIncomplete);
  const warn = incomplete.length
    ? `<p class="callout callout-warn"><strong>Incomplete cells:</strong> ${incomplete.length} of ${suite.cells.length} cells did not finish every planned run (${incomplete.map((c) => `${esc(c.server)} · ${esc(c.model)} ${runsText(c)}`).join('; ')}). Do not compare them as if complete.</p>`
    : '';
  return (
    `<section class="suite" aria-labelledby="${idBase}-h">` +
    `<h3 id="${idBase}-h">${esc(suite.suite)} <span class="sub">suite v${esc(suite.suiteVersion)}</span></h3>` +
    `<p class="meta">${meta.join(' · ')}</p>${warn}` +
    cellsTable(suite, idBase) +
    tasksTable(suite, idBase) +
    `</section>`
  );
}

/**
 * The main content for one run.
 * @param results a results.json (schema v2)
 * @param info its entry in data/index.json ({ runId, latest, traceBytes, notes })
 */
export function renderRun(results, info = {}) {
  const base = `data/runs/${encodeURIComponent(results.runId)}`;
  const runs = totalRuns(results);
  const commit = shortCommit(results.harnessCommit);
  const badges = [info.latest ? '<span class="badge badge-accent">latest</span>' : '', results.partial ? '<span class="badge badge-warn">partial run</span>' : ''].join(' ');
  const meta = [
    `started ${utc(results.startedAt)}`,
    `finished ${utc(results.finishedAt)}`,
    `${int(runs)} runs`,
    `${usd2(results.totalCostUsd)} total`,
  ];
  const partial = results.partial
    ? '<p class="callout callout-warn"><strong>Partial run:</strong> this run stopped (budget cap, out of credits, unknown cost or repeated provider errors) before every planned run finished. Cells marked incomplete are not comparable with complete ones.</p>'
    : '';
  const notes = (info.notes ?? []).length ? `<ul class="run-notes">${info.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
  const links = [
    `<a href="${base}/results.json">results.json</a>`,
    info.traceBytes == null ? '<span class="sub">no traces published</span>' : `<a href="${base}/traces.jsonl.gz">traces.jsonl.gz</a> <span class="sub">${bytes(info.traceBytes)}, one JSON trace per run</span>`,
    `<a href="${METHODOLOGY_URL}">methodology</a>`,
    `<a href="${SUITES_URL}">suites, tasks and graders</a>`,
    `<a href="${REPO_URL}">repository</a>`,
  ];
  return (
    `<section class="run" aria-labelledby="run-h" data-run="${esc(results.runId)}">` +
    `<h2 id="run-h">Run ${esc(results.startedAt.slice(0, 10))} ${badges}</h2>` +
    `<p class="meta"><code class="run-id">${esc(results.runId)}</code> · ${meta.join(' · ')} · harness ${esc(results.harnessVersion)}${commit ? ` @ <code>${esc(commit)}</code>` : ''}</p>` +
    partial +
    notes +
    `<ul class="links">${links.map((l) => `<li>${l}</li>`).join('')}</ul>` +
    results.suites.map((s, i) => suiteSection(results, s, i)).join('') +
    `</section>`
  );
}

/** Footer: run provenance and the caveats. */
export function renderFooter(results) {
  const commit = shortCommit(results.harnessCommit);
  const commitHtml = commit ? `<a href="${REPO_URL}/commit/${esc(results.harnessCommit)}"><code>${esc(commit)}</code></a>` : 'unknown';
  const repeats = repeatsOf(results);
  return (
    `<div class="footer-inner">` +
    `<h2 class="footer-h">About this run</h2>` +
    `<dl class="facts">` +
    `<div><dt>Run</dt><dd><code>${esc(results.runId)}</code>${results.partial ? ' (partial)' : ''}</dd></div>` +
    `<div><dt>Harness</dt><dd>mcp-evals ${esc(results.harnessVersion)}, commit ${commitHtml}</dd></div>` +
    `<div><dt>Dates</dt><dd>${utc(results.startedAt)} to ${utc(results.finishedAt)}</dd></div>` +
    `<div><dt>Total cost</dt><dd>${usd2(results.totalCostUsd)} <span class="sub">all spend, error and cut-off runs included</span></dd></div>` +
    `</dl>` +
    `<h2 class="footer-h">Caveats</h2>` +
    `<ul class="caveats">` +
    `<li><strong>The harness author also wrote NeatCode</strong>, one of the servers compared here. Tasks, answer keys and graders are public in <a href="${SUITES_URL}">suites/</a>, and every trace is published, so the comparison can be audited.</li>` +
    `<li><strong>Small samples, optimistic intervals.</strong> ${repeats ? `${repeats} repeat${repeats === 1 ? '' : 's'} per task. ` : ''}The 95% intervals are Wilson intervals that assume independent runs; runs are clustered by task, so the intervals are optimistic and the real uncertainty is larger. Read the intervals, not just the point estimates.</li>` +
    `<li><strong>Context tokens are a proxy.</strong> They count the text returned by tool calls with one tokenizer (<code>o200k_base</code>) for every model and exclude tool schemas. Provider prompt tokens use each model's own tokenizer, include schemas and the re-sent conversation, and are not comparable across models.</li>` +
    `<li><strong>Error runs</strong> (rate limits, crashes) are excluded from success and the per-task metrics, and counted as failures in “success, errors as fails”. Latency excludes setup and indexing.</li>` +
    `<li>One fixture per suite; results may not transfer to other languages or repo sizes, and providers are not perfectly deterministic even at temperature 0.</li>` +
    `</ul>` +
    `<p>How every number is measured, the fairness rules and the known limitations: <a href="${METHODOLOGY_URL}">methodology</a>. Source: <a href="${REPO_URL}">${esc(REPO_URL.replace('https://', ''))}</a> (MIT).</p>` +
    `</div>`
  );
}

/** <option>s for the run picker; index is data/index.json (latest first). */
export function renderRunOptions(index, selectedId) {
  return index
    .map((r) => {
      const label = [utc(r.startedAt), r.suites.join(', '), `${int(r.runs)} runs`, r.latest ? 'latest' : '', r.partial ? 'partial' : ''].filter(Boolean).join(' · ');
      return `<option value="${esc(r.runId)}"${r.runId === selectedId ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}
