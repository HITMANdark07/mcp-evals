import {
  catalogIssues,
  checkServers,
  ConfigError,
  estimateCost,
  fetchModelCatalog,
  fetchServedModels,
  OpenAICompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER,
  OpenRouterProvider,
  servedModelIssues,
  type CatalogModel,
  type Connector,
  type FixtureManager,
  type ModelPrice,
  type PlanPreview,
  type Suite,
} from '@mcp-evals/core';
import { readResultsFile } from '../files.js';
import { usd } from '../report/table.js';

export interface PreflightInput {
  suites: Suite[];
  servers?: string[];
  plan: PlanPreview;
  fixtures: FixtureManager;
  connector: Connector;
  env: Record<string, string | undefined>;
  baseUrl?: string;
  budgetUsd?: number;
  yes?: boolean;
  estimateFrom?: string;
  log: (line: string) => void;
}

/** Everything that must hold before an OpenRouter run spends money. Throws ConfigError (exit 2) otherwise. */
export async function openRouterPreflight(i: PreflightInput): Promise<OpenRouterProvider> {
  const apiKey = i.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError('OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key, or export OPENROUTER_API_KEY in your shell.');
  }
  const endpoint = { apiKey, ...(i.baseUrl ? { baseUrl: i.baseUrl } : {}) };
  let catalog: Map<string, CatalogModel>;
  try {
    catalog = await fetchModelCatalog(endpoint);
  } catch (e) {
    throw new ConfigError(`pre-flight: cannot fetch the OpenRouter model catalog: ${e instanceof Error ? e.message : String(e)}`);
  }
  const issues = catalogIssues({ suites: i.suites, planned: i.plan.planned, catalog });
  if (issues.length > 0) throw new ConfigError(`pre-flight failed:\n  - ${issues.join('\n  - ')}`);

  i.log('pre-flight: starting each server once');
  const checks = await checkServers({ suites: i.suites, ...(i.servers ? { servers: i.servers } : {}), connector: i.connector, fixtures: i.fixtures });
  for (const c of checks) i.log(`  ${c.suite}/${c.server}: ${c.tools} tools${c.version ? `, version ${c.version}` : ''}`);

  const prices = new Map<string, ModelPrice | null>([...catalog].map(([id, m]) => [id, m.price]));
  const measured = i.estimateFrom ? await readResultsFile(i.estimateFrom) : undefined;
  const est = estimateCost({ remaining: i.plan.remaining, prices, ...(measured ? { measured } : {}) });
  const planned = i.plan.planned.reduce((s, c) => s + c.runs, 0);
  i.log(`plan: ${planned} run(s), ${est.runs} to execute; estimated cost ${usd(est.usd)}`);
  for (const m of est.perModel) {
    const basis = m.basis === 'measured' ? 'measured' : 'catalog price × 25k prompt + 1k completion tokens';
    i.log(`  ${m.model}: ${m.runs} run(s) × ${usd(m.usdPerRun)} (${basis})`);
  }
  if (i.budgetUsd !== undefined && est.usd > i.budgetUsd && !i.yes) {
    throw new ConfigError(
      `estimated cost ${usd(est.usd)} exceeds --budget-usd ${usd(i.budgetUsd)}. Reduce --models/--repeats/--tasks, ` +
        `or re-run with --yes to start anyway (the cap still stops spending at ${usd(i.budgetUsd)}).`,
    );
  }
  const knownPrices = Object.fromEntries([...catalog].flatMap(([id, m]) => (m.price ? [[id, m.price] as const] : [])));
  return new OpenRouterProvider({ ...endpoint, prices: knownPrices });
}

export interface LocalPreflightInput {
  suites: Suite[];
  servers?: string[];
  plan: PlanPreview;
  fixtures: FixtureManager;
  connector: Connector;
  env: Record<string, string | undefined>;
  baseUrl: string;
  log: (line: string) => void;
}

/**
 * Pre-flight for an OpenAI-compatible (local) server: every planned model is listed by GET {base}/models, and every
 * server starts once. Throws ConfigError (exit 2) otherwise. Cost is not measured for this provider, so the
 * estimate is $0 and the budget check cannot fail.
 */
export async function openAICompatiblePreflight(i: LocalPreflightInput): Promise<OpenAICompatibleProvider> {
  const apiKey = i.env.OPENAI_COMPATIBLE_API_KEY?.trim();
  const endpoint = { baseUrl: i.baseUrl, ...(apiKey ? { apiKey } : {}) };
  const provider = new OpenAICompatibleProvider(endpoint); // validates the URL first
  const shown = displayUrl(i.baseUrl);
  let served: Set<string>;
  try {
    served = await fetchServedModels(endpoint);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`pre-flight: cannot list models at ${shown}/models (is the server running?): ${e instanceof Error ? e.message : String(e)}`);
  }
  const issues = servedModelIssues({ suites: i.suites, planned: i.plan.planned, served });
  if (issues.length > 0) throw new ConfigError(`pre-flight failed:\n  - ${issues.join('\n  - ')}`);
  i.log(`pre-flight: ${served.size} model(s) listed by ${shown}`);

  i.log('pre-flight: starting each server once');
  const checks = await checkServers({ suites: i.suites, ...(i.servers ? { servers: i.servers } : {}), connector: i.connector, fixtures: i.fixtures });
  for (const c of checks) i.log(`  ${c.suite}/${c.server}: ${c.tools} tools${c.version ? `, version ${c.version}` : ''}`);

  const planned = i.plan.planned.reduce((s, c) => s + c.runs, 0);
  const remaining = i.plan.remaining.reduce((s, c) => s + c.runs, 0);
  i.log(`plan: ${planned} run(s), ${remaining} to execute; estimated cost ${usd(0)} (cost is not measured for ${OPENAI_COMPATIBLE_PROVIDER}: local servers report no price)`);
  return provider;
}

/** The base URL without any user:password part, for messages. */
function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return raw;
  }
}
