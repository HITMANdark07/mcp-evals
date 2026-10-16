import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { compareCommand, type CompareCommandOptions } from './commands/compare.js';
import { reportCommand, type ReportCommandOptions } from './commands/report.js';
import { runCommand, type RunCommandOptions } from './commands/run.js';
import { CLI_VERSION } from './version.js';

export interface ProgramDeps {
  run: (o: RunCommandOptions) => Promise<{ exitCode: number }>;
  compare: (o: CompareCommandOptions) => Promise<{ exitCode: number }>;
  report: (o: ReportCommandOptions) => Promise<{ exitCode: number }>;
  writeOut: (s: string) => void;
  writeErr: (s: string) => void;
}

const defaultDeps: ProgramDeps = {
  run: runCommand,
  compare: compareCommand,
  report: reportCommand,
  writeOut: (s) => process.stdout.write(s),
  writeErr: (s) => process.stderr.write(s),
};

type RunFlags = Omit<RunCommandOptions, 'suites' | 'retries' | 'connector' | 'log' | 'env' | 'openRouterBaseUrl' | 'now'>;

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

function positiveInt(flag: string) {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError(`${flag} must be a positive integer`);
    return n;
  };
}

function positiveNumber(flag: string) {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`${flag} must be a positive number`);
    return n;
  };
}

function nonNegativeNumber(flag: string) {
  return (v: string) => {
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n) || n < 0) throw new InvalidArgumentError(`${flag} must be a non-negative number`);
    return n;
  };
}

/** Runs the CLI and returns the exit code: the command's own, 2 for any usage error, 0 for --help/--version. */
export async function main(argv: string[], deps: ProgramDeps = defaultDeps): Promise<number> {
  let exitCode = 0;
  const program = new Command()
    .name('mcp-evals')
    .description('Benchmark MCP servers and the models that use them')
    .version(CLI_VERSION)
    .exitOverride()
    .configureOutput({ writeOut: deps.writeOut, writeErr: deps.writeErr });

  program
    .command('run')
    .description('Run one or more suites and write results.json')
    .argument('<suites...>', 'suite YAML files')
    .addOption(new Option('--provider <name>', 'model provider').choices(['openrouter', 'mock']).default('openrouter'))
    .option('--mock-script <path>', 'scripted responses for --provider mock')
    .option('--models <ids>', 'comma-separated model ids to run', list)
    .option('--servers <names>', 'comma-separated server names to run', list)
    .option('--tasks <ids>', 'comma-separated task ids to run', list)
    .option('--repeats <n>', 'override repeats per task', positiveInt('--repeats'))
    .option('--budget-usd <n>', 'hard cost cap for this invocation', positiveNumber('--budget-usd'))
    .option('--resume <runId>', 'continue a cached run, skipping the runs it already finished')
    .option('--yes', 'start even if the pre-flight estimate exceeds --budget-usd')
    .option('--estimate-from <results.json>', 'estimate cost from measured cost per run in earlier results (e.g. a smoke run)')
    .option('--out <path>', 'results file', 'results.json')
    .option('--traces <path>', 'write traces as JSONL')
    .option('--cache-dir <path>', 'fixture cache directory', '.mcp-evals/cache')
    .option('--runs-dir <path>', 'run cache directory (used by --resume)', '.mcp-evals/runs')
    .action(async (suites: string[], opts: RunFlags) => {
      exitCode = (await deps.run({ suites, ...opts })).exitCode;
    });

  program
    .command('compare')
    .description('Compare two results files; exit 1 on regression')
    .argument('<base>', 'baseline results.json')
    .argument('<head>', 'new results.json')
    .option('--max-success-drop <pts>', 'regression when success drops by more than this many percentage points', nonNegativeNumber('--max-success-drop'), 5)
    .option('--max-context-increase <pct>', 'regression when median context tokens rise by more than this percent', nonNegativeNumber('--max-context-increase'), 20)
    .addOption(new Option('--format <format>', 'output format').choices(['table', 'markdown', 'json']).default('table'))
    .action(async (base: string, head: string, opts: Omit<CompareCommandOptions, 'base' | 'head' | 'log'>) => {
      exitCode = (await deps.compare({ base, head, ...opts })).exitCode;
    });

  program
    .command('report')
    .description('Print a results file as a table or markdown')
    .argument('<results>', 'results.json')
    .addOption(new Option('--format <format>', 'output format').choices(['table', 'markdown']).default('table'))
    .action(async (results: string, opts: Omit<ReportCommandOptions, 'results' | 'log'>) => {
      exitCode = (await deps.report({ results, ...opts })).exitCode;
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    throw e;
  }
}
