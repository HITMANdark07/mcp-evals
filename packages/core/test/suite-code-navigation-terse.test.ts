import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runGraders } from '../src/graders.js';
import { loadSuite } from '../src/suite/load.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const suite = await loadSuite(join(ROOT, 'suites/code-navigation.yaml'));

async function passes(taskId: string, answer: string): Promise<boolean> {
  const task = suite.tasks.find((t) => t.id === taskId)!;
  const results = await runGraders(task.graders, {
    server: 'filesystem', finalAnswer: answer, events: [], steps: 1, contextTokens: 0,
    workspace: { dir: ROOT, snapshot: new Map() }, taskPrompt: task.prompt,
  });
  return results.every((g) => g.pass);
}

const COMPOSE_OK: Array<[string, string]> = [
  ['terse: and', 'src/hono-base.ts: #dispatch and route\nsrc/middleware/combine/index.ts: every'],
  ['terse: comma', 'src/hono-base.ts: route, #dispatch\nsrc/middleware/combine/index.ts: every'],
  ['terse: Class#method', '`HonoBase#route` and `HonoBase#dispatch` in src/hono-base.ts; `every` in src/middleware/combine/index.ts'],
  ['long prose gap', 'src/middleware/combine/index.ts defines several combinators that build middleware out of other middleware, and the one that calls compose directly, as opposed to the others, is every.\nsrc/hono-base.ts: #dispatch, route'],
  ['table', '| File | Function |\n|---|---|\n| src/hono-base.ts | `#dispatch` |\n| src/hono-base.ts | `route` |\n| src/middleware/combine/index.ts | `every` |'],
  ['bullets', '- src/hono-base.ts: `route()`\n- src/hono-base.ts: `#dispatch`\n- src/middleware/combine/index.ts: `every()`'],
  ['prose', 'In src/hono-base.ts the private #dispatch method and the route method call compose. In src/middleware/combine/index.ts the every function does too.'],
];
const COMPOSE_BAD: Array<[string, string]> = [
  ['router not route', 'src/hono-base.ts: #dispatch, and the router\nsrc/middleware/combine/index.ts: every'],
  ['decoy file', 'src/hono-base.ts: #dispatch, route\nsrc/middleware/combine/index.ts: every\nsrc/jsx/dom/intrinsic-element/components.ts: composeRef'],
  ['prompt echo', 'Functions or methods under src/ that call compose from src/compose.ts, with file path and the enclosing function.'],
  ['no every', 'src/hono-base.ts: #dispatch, route\nsrc/middleware/combine/index.ts: some, except'],
];
const FETCH_OK: Array<[string, string]> = [
  ['terse: path after', '1. fetch — src/hono-base.ts\n2. #dispatch — src/hono-base.ts\n3. match — src/router/smart-router/router.ts\n4. compose — src/compose.ts'],
  ['table', '| Step | Function | File |\n|---|---|---|\n| 1 | `fetch` | src/hono-base.ts |\n| 2 | `dispatch` | src/hono-base.ts |\n| 3 | `match` | src/router/reg-exp-router/router.ts |\n| 4 | `compose` | src/compose.ts |'],
  ['bullets', '- `fetch` (src/hono-base.ts)\n- `#dispatch` (src/hono-base.ts)\n- `router.match()` (src/router/trie-router/router.ts)\n- `compose()` (src/compose.ts)'],
  ['prose', 'app.fetch in src/hono-base.ts calls #dispatch, which calls this.router.match(...) in src/router/smart-router/router.ts and finally compose(...) from src/compose.ts.'],
];
const FETCH_BAD: Array<[string, string]> = [
  ['prompt echo', 'Trace a request from fetch to where matched handlers are composed: fetch, dispatch, match, compose. src/hono-base.ts src/compose.ts'],
  ['wrong order', '`compose` (src/compose.ts), `match` (src/router/router.ts), `dispatch`, `fetch` (src/hono-base.ts)'],
  ['no router match', '`fetch`, `dispatch` in src/hono-base.ts, then compose(...) in src/compose.ts, once the handlers match.'],
];

describe('code-navigation graders accept terse correct answers and reject wrong ones', () => {
  it.each(COMPOSE_OK)('compose-callers passes: %s', async (_n, a) => expect(await passes('compose-callers', a)).toBe(true));
  it.each(COMPOSE_BAD)('compose-callers fails: %s', async (_n, a) => expect(await passes('compose-callers', a)).toBe(false));
  it.each(FETCH_OK)('fetch-to-compose passes: %s', async (_n, a) => expect(await passes('fetch-to-compose', a)).toBe(true));
  it.each(FETCH_BAD)('fetch-to-compose fails: %s', async (_n, a) => expect(await passes('fetch-to-compose', a)).toBe(false));
});
