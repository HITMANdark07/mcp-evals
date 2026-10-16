import type { Results } from '@mcp-evals/core';
import { ci, isIncomplete, pct, runsText, usd } from './table.js';

const HEADER = '| Server | Model | Runs | Success | Success w/ errors | 95% CI | Tool acc. | Invalid tool calls | Context tok. (median) | Provider prompt tok. (median) | Steps | $/task | Errors |';

export function formatMarkdown(r: Results): string {
  const out: string[] = [
    `## mcp-evals results — run \`${r.runId}\``,
    '',
    `Harness ${r.harnessVersion}${r.harnessCommit ? ` (${r.harnessCommit})` : ''} · ${r.startedAt} → ${r.finishedAt} · total cost ${usd(r.totalCostUsd)}${r.partial ? ' · **PARTIAL**' : ''}`,
  ];
  for (const s of r.suites) {
    out.push('', `### ${s.suite} (v${s.suiteVersion})`, '');
    if (s.fixture) out.push(`Fixture: ${s.fixture.git} @ \`${s.fixture.ref}\``);
    out.push(`Models: ${s.models.map((m) => `${m.id} (${m.provider})`).join(', ')}`);
    if (s.judge) out.push(`Judge: ${s.judge.id} (${s.judge.provider})`);
    out.push(`Servers: ${Object.entries(s.servers).map(([name, v]) => (v.version ? `${name} ${v.version}` : name)).join(', ')}`, '');
    out.push(HEADER, `|${HEADER.split('|').slice(1, -1).map(() => '---').join('|')}|`);
    for (const c of s.cells) {
      const cols = [
        c.server,
        c.model,
        runsText(c),
        c.successRate === null ? '–' : pct(c.successRate),
        c.successRateWithErrors === null ? '–' : pct(c.successRateWithErrors),
        ci(c.successCi95),
        c.toolAccuracy === null ? '–' : pct(c.toolAccuracy),
        c.invalidToolCallRate === null ? '–' : pct(c.invalidToolCallRate),
        String(Math.round(c.contextTokensPerTask.median)),
        c.providerPromptTokensPerTask === null ? '–' : String(Math.round(c.providerPromptTokensPerTask.median)),
        c.stepsPerTask.toFixed(1),
        usd(c.costUsdPerTask),
        pct(c.errorRate),
      ];
      out.push(`| ${cols.join(' | ')} |`);
    }
    const incomplete = s.cells.filter(isIncomplete);
    if (incomplete.length > 0) {
      out.push('', `Incomplete cells (not every planned run finished): ${incomplete.map((c) => `${c.server}/${c.model}`).join(', ')}`);
    }
  }
  return out.join('\n');
}
