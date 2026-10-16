import { loadDotEnv } from './env.js';
import { main } from './program.js';

// Load .env from the working directory before anything reads the environment; variables already set win.
if (loadDotEnv() === 'unsupported') {
  process.stderr.write('warning: found .env, but this Node version has no process.loadEnvFile (needs Node >= 20.12); export the variables in your shell instead\n');
}
process.exitCode = await main(process.argv.slice(2));
