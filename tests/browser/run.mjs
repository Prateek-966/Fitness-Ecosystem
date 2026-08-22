/**
 * Browser test runner: build output is served by `vite preview`, the smoke
 * suite runs against it, and the server dies with the runner either way.
 */
import { spawn } from 'node:child_process';

const PORT = 4173;
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
});

const up = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

let code = 1;
try {
  if (!(await up())) throw new Error('preview server never came up');
  code = await new Promise((resolve) => {
    const t = spawn('node', ['tests/browser/smoke.mjs'], {
      stdio: 'inherit', env: { ...process.env, BASE_URL: `http://localhost:${PORT}` },
    });
    t.on('exit', (c) => resolve(c ?? 1));
  });
} finally {
  preview.kill();
}
process.exit(code);
