/**
 * Browser smoke test.
 *
 * The node suite covers the core logic, but it cannot cover the two things
 * that only exist in a browser: SQLite compiled to WASM, and OPFS
 * persistence. This drives the built app in Chromium to check that the
 * database opens, that a typed entry lands, and — the part that matters —
 * that it is still there after a reload.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const results = [];
/** Unit labels carry their calibration ("piece (45 g)"), so match by prefix. */
const selectByPrefix = async (selector, prefix) => {
  const value = await page.$eval(
    selector,
    (el, p) => [...el.options].find((o) => o.textContent.trim().startsWith(p))?.value,
    prefix,
  );
  if (!value) throw new Error(`no option starting with "${prefix}" in ${selector}`);
  await page.selectOption(selector, value);
};

const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '×'} ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('\nBrowser smoke test\n');

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('button.mic', { timeout: 20000 });
check('app boots and renders the mic', true);

// --- storage ---
await page.click('nav.tabs button:has-text("Diagnostics")');
const storage = await page.locator('.stat', { hasText: 'Storage' }).innerText();
check('OPFS persistence is available', /OPFS/.test(storage), storage.replace(/\n/g, ' '));

// --- load food data through the same path a user would use ---
const foodCsv = [
  'food_code,food_name,energy_kcal,protein,fat,carbohydrate',
  'A001,Roti wheat,297,10.1,1.2,58.0',
  'A002,Rajma cooked,118,7.6,0.4,20.1',
].join('\n');
await page.setInputFiles('.card:has-text("Foods known") input[type=file]', {
  name: 'indb.csv', mimeType: 'text/csv', buffer: Buffer.from(foodCsv),
});
await page.waitForTimeout(400);
const foods = await page.locator('.stat', { hasText: 'Foods known' }).innerText();
check('food reference CSV loads in the browser', /2/.test(foods), foods.replace(/\n/g, ' '));

// --- a first log takes the slow path, because the index is empty ---
await page.click('nav.tabs button:has-text("Today")');
await page.fill('.card input[type=text]', 'two rotis');
await page.press('.card input[type=text]', 'Enter');
await page.waitForTimeout(300);
const firstToast = await page.locator('#toast').innerText();
check('an unknown phrase is queued, not guessed', /queue/i.test(firstToast), firstToast.replace(/\n/g, ' '));

// --- resolve it, which teaches the index ---
await page.click('nav.tabs button:has-text("Queue")');
await page.click('button:has-text("Resolve")');
await page.fill('.sheet input[type=search]', 'roti');
await page.waitForTimeout(250);
await page.click('.sheet button:has-text("pick")');
await selectByPrefix('.sheet .row select', 'piece');
await page.click('.sheet button:has-text("Log and learn")');
await page.waitForTimeout(300);
check('slow path resolves and writes back to the index', true);

// --- calibrate a piece, so grams can be derived ---
await page.click('nav.tabs button:has-text("Measures")');
await page.click('li:has-text("piece") button');
await page.fill('.sheet input[type=number]', '45');
await page.click('.sheet button:has-text("Save")');
await page.waitForTimeout(300);
check('household measure calibration saves', true);

// --- the same phrase again should now be an exact match ---
await page.click('nav.tabs button:has-text("Today")');
await page.fill('.card input[type=text]', 'two rotis');
await page.press('.card input[type=text]', 'Enter');
await page.waitForTimeout(300);
const secondToast = await page.locator('#toast').innerText();
check('the learned phrase is instant the second time', /Logged roti/.test(secondToast),
      secondToast.replace(/\n/g, ' '));

// 1 roti (45 g) from the slow path + 2 rotis (90 g) from the fast path,
// at 297 kcal/100 g = 401. The number has to come from the loaded CSV,
// not from anything hard-coded in the app.
const intake = await page.locator('.stat', { hasText: 'Intake index' }).innerText();
const shown = Number((intake.match(/([\d,]+)\s*\n?\s*±/) ?? [])[1]?.replace(/,/g, ''));
check('the intake index is computed from the loaded food data',
      Math.abs(shown - 401) <= 1, intake.replace(/\n/g, ' '));

// --- the whole point of OPFS: survive a reload ---
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('button.mic', { timeout: 20000 });
await page.waitForTimeout(500);
const afterReload = await page.locator('ul.list').first().innerText();
check('entries survive a reload', /Roti/i.test(afterReload), afterReload.split('\n').slice(0, 3).join(' '));

await page.click('nav.tabs button:has-text("Diagnostics")');
const diag = await page.locator('.card').first().innerText();
check('capture timing was recorded', /median \d+ ms/.test(diag),
      (diag.match(/median[^\n]*/) ?? [''])[0]);
check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed\n`);
process.exit(failed.length ? 1 : 0);
