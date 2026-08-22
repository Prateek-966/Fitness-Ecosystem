/**
 * Hosted-build check: runs the smoke suite against dist/ served by a dumb
 * static server, then verifies the service worker registers and the app
 * still boots from cache. This is what a Render deploy actually looks
 * like; `vite preview` is not.
 */
import { serve } from './static-server.mjs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4180;
const BASE = `http://localhost:${PORT}`;
const server = await serve(PORT);

const smoke = await new Promise((resolve) => {
  spawn('node', ['tests/browser/smoke.mjs'], {
    stdio: 'inherit', env: { ...process.env, BASE_URL: BASE },
  }).on('exit', (c) => resolve(c ?? 1));
});

console.log('\nService worker\n');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext()).newPage();
let swOk = false;
try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('button.mic', { timeout: 20000 });
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    if (!r) return null;
    await navigator.serviceWorker.ready;
    return r.scope;
  });
  console.log(`  ${reg ? '✓' : '×'} service worker registered  (${reg ?? 'none'})`);
  // Second load should come up with the worker already controlling.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('button.mic', { timeout: 20000 });
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  console.log(`  ${controlled ? '✓' : '×'} second load is served through the worker`);
  swOk = Boolean(reg) && controlled;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${smoke === 0 && swOk ? 'hosted build OK' : 'HOSTED BUILD FAILED'}\n`);
process.exit(smoke === 0 && swOk ? 0 : 1);
