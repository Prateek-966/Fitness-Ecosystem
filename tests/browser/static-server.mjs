/**
 * A deliberately dumb static file server, standing in for Render.
 *
 * `vite preview` is friendlier than a real static host — it can rewrite,
 * and it knows this project. Serving dist/ with nothing but a MIME table
 * is the honest test of "does the built output work when hosted".
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../../dist/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function serve(port = 4180) {
  const server = createServer(async (req, res) => {
    // Path traversal: normalize, then confirm the result is still inside root.
    const url = new URL(req.url, 'http://localhost');
    let path = join(ROOT, normalize(decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
      const body = await readFile(path);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
        // Mirrors render.yaml: hashed assets immutable, everything else fresh.
        'Cache-Control': url.pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    } catch {
      // No SPA rewrite, exactly as configured. A 404 stays a 404.
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(Number(process.env.PORT ?? 4180));
  console.log(`serving dist/ on ${process.env.PORT ?? 4180}`);
}
