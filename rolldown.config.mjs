import { defineConfig } from 'rolldown';

// Bundling replaces ~50 module files with a few chunks: fewer file reads on every hook and CLI start.
// The bundle stays at dist/waymark.js because installed hooks and MCP configs point at that path.
export default defineConfig({
  input: { waymark: 'src/waymark/cli/index.ts' },
  platform: 'node',
  external: ['better-sqlite3', /^node:/],
  output: { dir: 'dist', format: 'esm', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
});
