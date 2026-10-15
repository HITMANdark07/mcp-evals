import { createRequire } from 'node:module';

// Resolves to packages/cli/package.json from both src/ and dist/.
export const CLI_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
