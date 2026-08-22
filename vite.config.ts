import { defineConfig } from 'vite';

export default defineConfig({
  // sqlite-wasm ships its own worker and .wasm; leave it unbundled so the
  // WASM binary is fetched as a static asset rather than inlined.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: { target: 'es2022' },
  server: { host: true },
});
