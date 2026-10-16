import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFakeServer } from '../../test/fixtures/fake-server.mjs';
import { ConfigError } from '../errors.js';
import { FixtureManager } from '../fixtures/manager.js';
import { createInMemoryConnector } from '../mcp/connection.js';
import type { CatalogModel, ModelPrice } from '../providers/openrouter.js';
import type { Results } from '../results/schema.js';
import { parseSuite } from '../suite/load.js';
import type { Connector } from '../types.js';
import { catalogIssues, checkServers, estimateCost, measuredCostPerRun } from './preflight.js';

const SUITE = `
suite: demo
version: 1
servers:
  fake: { command: unused }
  other: { command: unused, setup: "exit 3" }
models: [{ id: acme/a, provider: acme }, acme/b]
judge: { id: acme/judge, provider: acme }
tasks:
  - id: t
    prompt: "ECHO"
    graders: [{ type: llm_judge, rubric: "x" }]
`;
const suite = parseSuite(SUITE, 'demo.yaml');
const memory: Connector = createInMemoryConnector((ctx) => buildFakeServer(ctx.cwd));

async function fixtures() {
  const root = await mkdtemp(join(tmpdir(), 'preflight-'));
  return new FixtureManager({ cacheDir: join(root, 'cache'), workRoot: join(root, 'work') });
}

describe('checkServers', () => {
  it('starts each selected server once and reports its tools and version', async () => {
    expect(await checkServers({ suites: [suite], servers: ['fake'], connector: memory, fixtures: await fixtures() })).toEqual([
      { suite: 'demo', server: 'fake', tools: 8, version: '1.0.0' },
    ]);
  });

  it('turns a server that cannot start, or whose setup fails, into a ConfigError naming it', async () => {
    const boom: Connector = () => Promise.reject(new Error('spawn exploded'));
    const err = await checkServers({ suites: [suite], servers: ['fake'], connector: boom, fixtures: await fixtures() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/^pre-flight: server "fake" \(suite demo\) failed: spawn exploded/);
    await expect(checkServers({ suites: [suite], servers: ['other'], connector: memory, fixtures: await fixtures() })).rejects.toThrow(
      /server "other".*setup command failed/s,
    );
  });
});

const prices = new Map<string, ModelPrice | null>([
  ['acme/a', { prompt: 0.000002, completion: 0.00001 }],
  ['acme/b', { prompt: 0.00000015, completion: 0.00000047 }],
  ['acme/free', null],
]);

const measured: Results = {
  schemaVersion: 2, harnessVersion: '0', runId: 'smoke', startedAt: 'a', finishedAt: 'b', partial: false, totalCostUsd: 0.012,
  suites: [{
    suite: 'demo', suiteVersion: 1, fixture: null, servers: {}, models: [], judge: null,
    cells: [
      { server: 'fake', model: 'acme/b', runs: 3, plannedRuns: 3, complete: true, successRate: 1, successCi95: [0, 1], toolAccuracy: null,
        contextTokensPerTask: { mean: 0, median: 0 }, providerPromptTokensPerTask: null, stepsPerTask: 1, latencyMsP50: 1, costUsdPerTask: 0.004, errorRate: 0, tasks: [] },
      { server: 'other', model: 'acme/b', runs: 2, plannedRuns: 2, complete: true, successRate: null, successCi95: [0, 1], toolAccuracy: null,
        contextTokensPerTask: { mean: 0, median: 0 }, providerPromptTokensPerTask: null, stepsPerTask: 0, latencyMsP50: 0, costUsdPerTask: 0, errorRate: 1, tasks: [] },
    ],
  }],
};

describe('estimateCost', () => {
  it('uses catalog prices × 25k prompt + 1k completion tokens per run', () => {
    const est = estimateCost({ remaining: [{ suite: 'demo', server: 'fake', model: 'acme/a', runs: 6 }, { suite: 'demo', server: 'other', model: 'acme/a', runs: 4 }], prices });
    expect(est.runs).toBe(10);
    expect(est.perModel).toEqual([{ model: 'acme/a', runs: 10, usdPerRun: expect.closeTo(0.06, 12), basis: 'catalog' }]);
    expect(est.usd).toBeCloseTo(0.6, 12);
  });

  it('prefers the measured cost per run of earlier results, per model, ignoring errored runs', () => {
    expect(measuredCostPerRun(measured, 'acme/b')).toBeCloseTo(0.004, 12);
    expect(measuredCostPerRun(measured, 'acme/a')).toBeUndefined();
    const est = estimateCost({
      remaining: [{ suite: 'demo', server: 'fake', model: 'acme/a', runs: 1 }, { suite: 'demo', server: 'fake', model: 'acme/b', runs: 10 }],
      prices,
      measured,
    });
    expect(est.perModel.map((m) => [m.model, m.basis])).toEqual([['acme/a', 'catalog'], ['acme/b', 'measured']]);
    expect(est.usd).toBeCloseTo(0.06 + 0.04, 12);
  });

  it('fails loudly for a model without a catalog price', () => {
    expect(() => estimateCost({ remaining: [{ suite: 'demo', server: 'fake', model: 'acme/free', runs: 1 }], prices })).toThrow(/no price for model "acme\/free"/);
  });
});

describe('catalogIssues', () => {
  const catalog = new Map<string, CatalogModel>([
    ['acme/a', { id: 'acme/a', supportsTools: true, price: null }],
    ['acme/b', { id: 'acme/b', supportsTools: false, price: null }],
  ]);
  it('flags unpinned models, models without tool support or missing from the catalog, and a missing judge', () => {
    const planned = [
      { suite: 'demo', server: 'fake', model: 'acme/a', runs: 1 },
      { suite: 'demo', server: 'fake', model: 'acme/b', runs: 1 },
    ];
    expect(catalogIssues({ suites: [suite], planned, catalog })).toEqual([
      'suite demo: model "acme/b" has no provider pin; write it as { id: acme/b, provider: <slug> }',
      'suite demo: model "acme/b" does not support tool calling on OpenRouter',
      'suite demo: judge "acme/judge" is not in the OpenRouter catalog',
    ]);
    expect(catalogIssues({ suites: [suite], planned: [planned[0]!], catalog: new Map([...catalog, ['acme/judge', { id: 'acme/judge', supportsTools: false, price: null }]]) })).toEqual([]);
  });
});
