/**
 * Rasterize public/icon.svg to the PNG sizes the manifest and iOS expect.
 * Chromium is the renderer so the PNGs match what the browser shows.
 * Run once (npm run icons) and commit the output.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const b64 = Buffer.from(svg).toString('base64');

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext()).newPage();

for (const size of [512, 192, 180]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>*{margin:0}</style><img src="data:image/svg+xml;base64,${b64}" width="${size}" height="${size}">`,
  );
  await page.screenshot({ path: `public/icon-${size}.png`, omitBackground: true });
  console.log(`public/icon-${size}.png`);
}
await browser.close();
