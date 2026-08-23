/** Boots the real server against the built app, runs the sync checks. */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';

/**
 * Claim a free port rather than hardcoding one. A fixed port makes the
 * suite fail for reasons that have nothing to do with the code - a
 * leftover process, or a host that reserves that number.
 */
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const PORT = await freePort();
const TOKEN = 'integration-token-long-enough-xyz';
const DB = '/tmp/nutrition-sync-itest.sqlite3';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

// Capture the server's output rather than discarding it: a runner that
// can only say "never came up" makes you debug it twice.
const log = [];
const server = spawn('node', ['--experimental-strip-types', 'server/src/index.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    SYNC_TOKEN: TOKEN, GARMIN_ADAPTER: 'fake',
    SYNC_DB: DB, STATIC_DIR: './dist', PORT: String(PORT),
  },
});

server.stdout.on('data', (d) => log.push(String(d)));
server.stderr.on('data', (d) => log.push(String(d)));
server.on('error', (e) => log.push(`spawn error: ${e.message}`));

let lastProbeError = null;
const up = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return true;
    } catch (e) {
      lastProbeError = e?.cause?.code ?? e?.message ?? String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

let code = 1;
try {
  if (!(await up())) {
    throw new Error(
      `sync server never came up (last probe: ${lastProbeError}). `
      + `Server said:\n${log.join('') || '(nothing)'}`);
  }
  code = await new Promise((resolve) => {
    spawn('node', ['tests/browser/sync.mjs'], {
      stdio: 'inherit',
      env: { ...process.env, SYNC_BASE: `http://127.0.0.1:${PORT}`, SYNC_TOKEN: TOKEN },
    }).on('exit', (c) => resolve(c ?? 1));
  });
} finally {
  server.kill();
}
process.exit(code);
