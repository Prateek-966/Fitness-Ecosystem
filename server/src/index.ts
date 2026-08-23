import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { loadConfig, tokenMatches, ConfigError, type Config } from './config.ts';
import { SyncStore } from './store.ts';
import { Poller } from './poller.ts';
import { FakeGarmin } from './garmin/fake.ts';
import { ConnectGarmin } from './garmin/connect.ts';
import type { GarminClient } from './garmin/client.ts';

/**
 * One origin serves the app and the sync API.
 *
 * A separate API host would need CORS and a widened connect-src, and
 * every widening of a CSP on a page holding months of health data is a
 * door someone has to remember to keep shut. Same origin, same policy,
 * nothing to widen.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), camera=(), payment=(), interest-cohort=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' data:",
    // Same origin covers the sync API, so this stays exactly as narrow as
    // it was when the app was a static site.
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(payload);
}

/** Bearer check. Never reveals whether the token was close. */
function authorised(req: IncomingMessage, cfg: Config): boolean {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return presented !== '' && tokenMatches(presented, cfg.syncToken);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createApp(cfg: Config, poller: Poller, store: SyncStore) {
  const staticRoot = resolve(cfg.staticDir) + '/';

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // ---- liveness: no auth, and deliberately no data ----
    if (path === '/api/health') {
      return json(res, 200, { ok: true, adapter: cfg.adapter });
    }

    if (path.startsWith('/api/')) {
      if (!authorised(req, cfg)) {
        // A public URL must not confirm what it is holding.
        return json(res, 401, { error: 'unauthorised' });
      }

      if (path === '/api/garmin/status' && req.method === 'GET') {
        return json(res, 200, {
          ...poller.status(),
          credentialsConfigured: cfg.garmin !== null,
        });
      }

      if (path === '/api/garmin/sync' && req.method === 'POST') {
        const result = await poller.syncOnce();
        return json(res, result.ok ? 200 : 502, result);
      }

      if (path === '/api/garmin/data' && req.method === 'GET') {
        const since = url.searchParams.get('since') ?? '';
        if (!ISO_DATE.test(since)) {
          return json(res, 400, { error: 'since must be YYYY-MM-DD' });
        }
        return json(res, 200, store.read(since));
      }

      return json(res, 404, { error: 'no such endpoint' });
    }

    // ---- the built app ----
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS).end();
      return;
    }

    // Normalise first, then confirm the result is still inside the root.
    let file = join(staticRoot, normalize(decodeURIComponent(path)));
    if (!file.startsWith(staticRoot)) {
      res.writeHead(403, SECURITY_HEADERS).end();
      return;
    }

    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      const ext = extname(file);
      res.writeHead(200, {
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        // Vite content-hashes /assets, so those are immutable. Everything
        // else revalidates - a cached sw.js can never update itself.
        'Cache-Control': path.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      // No SPA rewrite: the app has no client-side router, so a missing
      // asset should stay a 404 rather than become HTML the service
      // worker would then cache under an asset URL.
      res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
      res.end('not found');
    }
  });
}

export function buildClient(cfg: Config): GarminClient {
  if (cfg.adapter === 'fake') return new FakeGarmin();
  if (!cfg.garmin) {
    throw new ConfigError(
      'GARMIN_EMAIL and GARMIN_PASSWORD are required unless GARMIN_ADAPTER=fake');
  }
  return new ConnectGarmin(cfg.garmin.email, cfg.garmin.password);
}

// ---- entry point ----
if (import.meta.url === `file://${process.argv[1]}`) {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    console.error(`[config] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const store = new SyncStore(cfg.dbPath);
  const client = buildClient(cfg);
  const poller = new Poller(client, store, cfg.intervalMin);

  createApp(cfg, poller, store).listen(cfg.port, () => {
    console.log(`[sync] listening on ${cfg.port}, adapter=${cfg.adapter}, `
      + `interval=${cfg.intervalMin}min, credentials=${cfg.garmin ? 'set' : 'MISSING'}`);
    if (cfg.garmin || cfg.adapter === 'fake') poller.start();
    else console.warn('[sync] no Garmin credentials; serving the app only');
  });
}
