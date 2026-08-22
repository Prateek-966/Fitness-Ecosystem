import { defineConfig, type Plugin } from 'vite';

/**
 * CSP, injected at build time only — the dev server needs inline HMR
 * machinery that a strict policy would fight.
 *
 * Defence in depth, not the defence: nothing in the app reaches an
 * innerHTML-style sink and no request leaves the origin, but this page
 * holds months of personal health data in OPFS, so a future slip should
 * fail loudly instead of exfiltrating quietly. 'wasm-unsafe-eval' is
 * WebAssembly instantiation, not JS eval. The database worker carries its
 * own (absent) policy — document meta CSP does not apply to workers — so
 * sqlite-wasm is unaffected either way.
 */
function cspMeta(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{
      tag: 'meta',
      injectTo: 'head-prepend' as const,
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
          "style-src 'self'",
          "img-src 'self' data:",
          "connect-src 'self'",
          "worker-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
      },
    }],
  };
}

export default defineConfig({
  // sqlite-wasm ships its own worker and .wasm; leave it unbundled so the
  // WASM binary is fetched as a static asset rather than inlined.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: { target: 'es2022' },
  server: { host: true },
  plugins: [cspMeta()],
});
