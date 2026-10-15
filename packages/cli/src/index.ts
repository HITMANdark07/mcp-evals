import { Command, InvalidArgumentError } from 'commander';
import { runCommand } from './commands/run.js';
import { CLI_VERSION } from './version.js';

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

const program = new Command().name('mcp-evals').description('Benchmark MCP servers and the models that use them').version(CLI_VERSION);

program
  .command('run')
  .description('Run one or more suites and write results.json')
  .argument('<suites...>', 'suite YAML files')
  .requiredOption('--provider <name>', 'model provider (M1: mock)')
  .option('--mock-script <path>', 'scripted responses for --provider mock')
  .option('--models <ids>', 'comma-separated model ids to run', list)
  .option('--servers <names>', 'comma-separated server names to run', list)
  .option('--repeats <n>', 'override repeats per task', positiveInt('--repeats'))
  .option('--budget-usd <n>', 'hard cost cap for the whole run', positiveNumber('--budget-usd'))
  .option('--out <path>', 'results file', 'results.json')
  .option('--traces <path>', 'write traces as JSONL')
  .option('--cache-dir <path>', 'fixture cache directory', '.mcp-evals/cache')
  .action(async (suites: string[], opts: { provider: string; mockScript?: string; models?: string[]; servers?: string[]; repeats?: number; budgetUsd?: number; out: string; traces?: string; cacheDir: string }) => {
    const { exitCode } = await runCommand({ suites, ...opts });
    process.exitCode = exitCode;
  });

await program.parseAsync();
