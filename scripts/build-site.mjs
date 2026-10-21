#!/usr/bin/env node
// Builds the static mcpbench leaderboard from data/ into site-dist/.
//
//   node scripts/build-site.mjs [--data <dir>] [--out <dir>]
//
// No dependencies beyond Node 20. Reads data/runs/<runId>/results.json (schema v2) and
// data/latest.json, copies them (and each run's traces.jsonl.gz) into <out>/data/, writes
// <out>/data/index.json (every run, latest first), and renders index.html with the latest
// run pre-rendered and every run embedded for the run picker.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const STATIC_FILES = ['style.css', 'app.js', 'render.js'];
/** Strings that must never reach the public site: local home paths and OpenRouter keys. */
const FORBIDDEN = ['/Users/', 'sk-or-'];
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

function parseArgs(argv) {
  const opts = { data: join(ROOT, 'data'), out: join(ROOT, 'site-dist') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data' || a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = resolve(v);
    } else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/build-site.mjs [--data <dir>] [--out <dir>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function checkResults(r, where) {
  const fail = (msg) => {
    throw new Error(`${where}: ${msg}`);
  };
  if (!r || typeof r !== 'object') fail('not a JSON object');
  if (r.schemaVersion !== 2) fail(`schemaVersion ${r.schemaVersion} (the site needs schema v2)`);
  for (const k of ['runId', 'startedAt', 'finishedAt', 'harnessVersion']) if (typeof r[k] !== 'string') fail(`missing ${k}`);
  if (typeof r.totalCostUsd !== 'number') fail('missing totalCostUsd');
  if (!Array.isArray(r.suites)) fail('missing suites');
  for (const s of r.suites) {
    if (!Array.isArray(s.cells) || !Array.isArray(s.models) || typeof s.servers !== 'object') fail(`suite ${s.suite}: missing cells, models or servers`);
    for (const c of s.cells) {
      if (!Array.isArray(c.tasks) || !Array.isArray(c.successCi95) || !c.contextTokensPerTask) fail(`cell ${c.server}/${c.model}: malformed`);
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Every published run, latest first. */
async function loadRuns(dataDir) {
  const runsDir = join(dataDir, 'runs');
  const entries = existsSync(runsDir) ? await readdir(runsDir, { withFileTypes: true }) : [];
  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(runsDir, e.name);
    const resultsPath = join(dir, 'results.json');
    if (!existsSync(resultsPath)) continue;
    if (!SAFE_RUN_ID.test(e.name)) throw new Error(`data/runs/${e.name}: unsafe run directory name`);
    const results = await readJson(resultsPath);
    checkResults(results, `data/runs/${e.name}/results.json`);
    if (results.runId !== e.name) throw new Error(`data/runs/${e.name}/results.json: runId is ${results.runId}`);
    const tracesPath = join(dir, 'traces.jsonl.gz');
    runs.push({ dir, results, tracesPath: existsSync(tracesPath) ? tracesPath : null });
  }
  runs.sort((a, b) => b.results.startedAt.localeCompare(a.results.startedAt) || b.results.runId.localeCompare(a.results.runId));
  return runs;
}

/** JSON that is safe inside <script type="application/json">. */
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** Refuses to ship local paths or API keys, including inside the gzipped traces. */
async function scanForSecrets(outDir) {
  const problems = [];
  for (const file of await walk(outDir)) {
    let buf = await readFile(file);
    if (file.endsWith('.gz')) buf = gunzipSync(buf);
    const text = buf.toString('utf8');
    for (const s of FORBIDDEN) if (text.includes(s)) problems.push(`${relative(outDir, file)} contains "${s}"`);
  }
  if (problems.length) throw new Error(`refusing to publish:\n  ${problems.join('\n  ')}`);
}

export async function buildSite({ data, out }) {
  const render = await import(pathToFileURL(join(SITE, 'render.js')).href);
  const runs = await loadRuns(data);
  if (runs.length === 0) throw new Error(`no published runs in ${join(data, 'runs')}`);

  const latestPath = join(data, 'latest.json');
  const latest = existsSync(latestPath) ? await readJson(latestPath) : null;
  if (latest) checkResults(latest, 'data/latest.json');
  const latestRunId = latest && runs.some((r) => r.results.runId === latest.runId) ? latest.runId : runs[0].results.runId;

  const notesPath = join(SITE, 'run-notes.json');
  const notes = existsSync(notesPath) ? await readJson(notesPath) : {};

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'data', 'runs'), { recursive: true });
  for (const f of STATIC_FILES) await copyFile(join(SITE, f), join(out, f));

  const index = [];
  for (const run of runs) {
    const r = run.results;
    const target = join(out, 'data', 'runs', r.runId);
    await mkdir(target, { recursive: true });
    await copyFile(join(run.dir, 'results.json'), join(target, 'results.json'));
    let traceBytes = null;
    if (run.tracesPath) {
      await copyFile(run.tracesPath, join(target, 'traces.jsonl.gz'));
      traceBytes = (await stat(run.tracesPath)).size;
    }
    index.push({
      runId: r.runId,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      harnessVersion: r.harnessVersion,
      harnessCommit: r.harnessCommit ?? null,
      partial: r.partial,
      totalCostUsd: r.totalCostUsd,
      suites: r.suites.map((s) => s.suite),
      runs: render.totalRuns(r),
      incompleteCells: r.suites.reduce((n, s) => n + s.cells.filter(render.isIncomplete).length, 0),
      latest: r.runId === latestRunId,
      traceBytes,
      notes: Array.isArray(notes[r.runId]) ? notes[r.runId] : [],
      results: `data/runs/${r.runId}/results.json`,
      traces: traceBytes === null ? null : `data/runs/${r.runId}/traces.jsonl.gz`,
    });
  }
  if (latest) await copyFile(latestPath, join(out, 'data', 'latest.json'));
  await writeFile(join(out, 'data', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  const latestRun = runs.find((r) => r.results.runId === latestRunId).results;
  const latestInfo = index.find((r) => r.runId === latestRunId);
  const embedded = { latestRunId, index, results: Object.fromEntries(runs.map((r) => [r.results.runId, r.results])) };
  const values = {
    REPO_URL: render.REPO_URL,
    METHODOLOGY_URL: render.METHODOLOGY_URL,
    RUN_OPTIONS: render.renderRunOptions(index, latestRunId),
    RUN_COUNT: `${index.length} published run${index.length === 1 ? '' : 's'}, newest first`,
    RUN_HTML: render.renderRun(latestRun, latestInfo),
    FOOTER_HTML: render.renderFooter(latestRun),
    DATA_JSON: scriptJson(embedded),
  };
  const template = await readFile(join(SITE, 'index.html'), 'utf8');
  const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error(`site/index.html: unknown placeholder ${m}`);
    return values[key];
  });
  await writeFile(join(out, 'index.html'), html);

  await scanForSecrets(out);
  return { out, runs: index.map((r) => r.runId), latestRunId };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = await buildSite(opts);
    console.log(`built ${relative(process.cwd(), res.out) || '.'}: ${res.runs.length} run(s), latest ${res.latestRunId}`);
  } catch (err) {
    console.error(`build-site: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
