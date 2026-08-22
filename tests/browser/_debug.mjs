import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const p = await (await b.newContext()).newPage();
p.on('console', m => console.log('[console]', m.type(), m.text().slice(0,400)));
p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0,400)));
await p.goto('http://localhost:4173', { waitUntil: 'networkidle' });
await p.waitForSelector('button.mic', { timeout: 20000 });
console.log('ENV', await p.evaluate(() => ({
  opfs: !!navigator.storage?.getDirectory,
  isolated: self.crossOriginIsolated,
  sab: typeof SharedArrayBuffer,
  secure: isSecureContext,
})));
await b.close();
