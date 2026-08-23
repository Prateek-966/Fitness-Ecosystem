/**
 * The app talking to the real sync server.
 *
 * The unit tests use a fake fetch and the server tests use a fake Garmin;
 * this is the only place the two halves meet over an actual socket, in a
 * real browser, against the built output. It is also the only test that
 * would have caught the container failing to boot.
 */
import { chromium } from 'playwright';

const BASE = process.env.SYNC_BASE ?? 'http://localhost:4190';
const TOKEN = process.env.SYNC_TOKEN ?? 'integration-token-long-enough-xyz';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '×'} ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('\nApp against the real sync server\n');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('button.mic', { timeout: 20000 });
check('app is served by the sync server', true);

await page.click('nav.tabs button:has-text("Diagnostics")');
await page.waitForTimeout(300);

// A wrong token must fail visibly, not look like an empty sync.
await page.fill('.card:has-text("Sync token") input[type=password]', 'wrong-token-same-length-abcdef');
await page.click('.card:has-text("Sync token") button:has-text("Save token")');
await page.waitForTimeout(700);
const rejected = await page.locator('.card:has-text("Sync token")').innerText();
check('a wrong token is reported, not swallowed', /rejected|problem/i.test(rejected),
      (rejected.match(/Sync problem[^\n]*/) ?? [''])[0].slice(0, 70));

await page.fill('.card:has-text("Sync token") input[type=password]', TOKEN);
await page.click('.card:has-text("Sync token") button:has-text("Save token")');
await page.waitForTimeout(900);
const configured = await page.locator('.card:has-text("Sync token")').innerText();
check('a good token verifies immediately', /fake/.test(configured) && !/rejected/i.test(configured),
      (configured.match(/Server\s+\S+/) ?? [''])[0]);

await page.click('.card:has-text("Sync token") button:has-text("Sync now")');
await page.waitForTimeout(1500);
const toast = await page.locator('#toast').innerText();
check('sync pulls workouts and daily values', /Pulled \d+ workouts and \d+ daily values/.test(toast),
      toast.replace(/\n/g, ' ').slice(0, 70));

// The data must have landed through the ordinary import path.
const coverage = await page.locator('.card:has-text("Garmin CSV export")').innerText();
check('pulled data appears in source coverage', /rhr bpm|sleep min/.test(coverage),
      (coverage.match(/(rhr bpm|sleep min)[^\n]*/) ?? [''])[0].slice(0, 60));

// Re-syncing must not duplicate.
const before = (coverage.match(/(\d+)\s*$/m) ?? [])[1];
await page.click('.card:has-text("Sync token") button:has-text("Sync now")');
await page.waitForTimeout(1500);
const after = await page.locator('.card:has-text("Garmin CSV export")').innerText();
check('re-syncing corrects rather than duplicates',
      after.match(/(\d+)\s*$/m)?.[1] === before, `${before} -> ${after.match(/(\d+)\s*$/m)?.[1]}`);

// It must survive a reload, like everything else.
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('button.mic', { timeout: 20000 });
await page.click('nav.tabs button:has-text("Diagnostics")');
await page.waitForTimeout(500);
const persisted = await page.locator('.card:has-text("Sync token")').innerText();
check('the token survives a reload', /set/i.test(persisted) || /Server/.test(persisted));

check('no uncaught page errors', errors.length === 0, errors.slice(0, 1).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} sync checks passed\n`);
process.exit(failed ? 1 : 0);
