import { defineConfig } from 'rolldown';

// Bundling replaces ~50 module files with a few chunks: fewer file reads on every hook and CLI start.
// The bundle stays at dist/waymark.js because installed hooks and MCP configs point at that path. It is built into dist-next and
// swapped in by `postbuild`, so a failed build or a build in progress never leaves agents without dist/waymark.js.
export default defineConfig({
  input: { waymark: 'src/waymark/cli/index.ts', optimize: 'src/waymark/cli/optimizeCommand.ts' },
  platform: 'node',
  external: ['better-sqlite3', /^node:/],
  output: { dir: 'dist-next', format: 'esm', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
});
