import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  // No source maps: the npm tarball must not embed local absolute paths, and the bundle is small enough to debug as is.
  sourcemap: false,
  target: 'node20',
  // Ship one package: the private workspace core is bundled in, its runtime dependencies stay real dependencies.
  noExternal: ['@mcp-evals/core'],
  banner: { js: '#!/usr/bin/env node' },
});
