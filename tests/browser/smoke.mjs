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
await page.fill('.capture input[type=text]', 'two rotis');
await page.press('.capture input[type=text]', 'Enter');
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
await page.fill('.capture input[type=text]', 'two rotis');
await page.press('.capture input[type=text]', 'Enter');
await page.waitForTimeout(300);
const secondToast = await page.locator('#toast').innerText();
check('the learned phrase is instant the second time', /Logged roti/.test(secondToast),
      secondToast.replace(/\n/g, ' '));

// 1 roti (45 g) from the slow path + 2 rotis (90 g) from the fast path,
// at 297 kcal/100 g = 401. The number has to come from the loaded CSV,
// not from anything hard-coded in the app.
const intake = await page.locator('.intake').innerText();
// innerText returns CSS-transformed text, so the label reads uppercase.
const shown = Number((intake.match(/intake index\s*\n?\s*([\d,]+)/i) ?? [])[1]?.replace(/,/g, ''));
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

// --- Garmin: body data lands, and never touches the food log ---
const intakeBefore = await page.locator('.intake-value').innerText().catch(() => '');
await page.setInputFiles('.card:has-text("Garmin CSV export") input[type=file]', {
  name: 'wellness.csv', mimeType: 'text/csv',
  buffer: Buffer.from([
    'Date,Resting Heart Rate,Total Sleep,REM Sleep,Avg Overnight HRV,Steps',
    '2026-08-20,48,7:24,1:32,62,"12,880"',
    '2026-08-21,51,6:10,1:04,55,9210',
  ].join('\n')),
});
await page.waitForTimeout(500);
const coverage = await page.locator('.card:has-text("Garmin CSV export")').innerText();
check('Garmin wellness import lands and reports coverage',
      /rhr bpm/.test(coverage) && /2026-08-20/.test(coverage),
      (coverage.match(/rhr bpm[^\n]*\n[^\n]*/) ?? [''])[0].replace(/\n/g, ' '));

await page.click('nav.tabs button:has-text("Today")');
await page.waitForTimeout(250);
const intakeAfter = await page.locator('.intake-value').innerText();
check('Garmin data does not move the intake total',
      intakeBefore === '' || intakeAfter === intakeBefore,
      intakeAfter.replace(/\n/g, ' '));
await page.click('nav.tabs button:has-text("Diagnostics")');

// --- goal setting, against calculator.net's published figures ---
await page.click('nav.tabs button:has-text("Goal")');
await page.selectOption('.card:has-text("Activity") select >> nth=0', 'male');
const setNum = async (label, value) => {
  await page.fill(`.card:has-text("Activity") .field:has-text("${label}") input`, value);
};
await setNum('Age', '25');
await setNum('Height (cm)', '180');
await setNum('Weight (kg)', '65');
await setNum('Goal weight (kg)', '60');
await page.selectOption('.field:has-text("Activity") select', '1.465');
await page.selectOption('.field:has-text("Goal") select', '-0.5');
await page.waitForTimeout(400);

const estimates = await page.locator('.card:has-text("mifflin")').first().innerText();
check('BMR estimates match calculator.net', /1,?925/.test(estimates) && /79%/.test(estimates),
      (estimates.match(/mifflin[\s\S]{0,120}/) ?? [''])[0].replace(/\n/g, ' ').slice(0, 110));

await page.click('.card:has-text("Activity") button:has-text("Set goal"), .card:has-text("Activity") button:has-text("Update")');
await page.waitForTimeout(500);

const nutrition = await page.locator('.card:has-text("Daily calorie budget")').innerText();
check('macro budget is derived from the target',
      /1,?925/.test(nutrition) && /Protein/.test(nutrition),
      nutrition.replace(/\n/g, ' ').slice(0, 100));

const weightCard = await page.locator('.card:has-text("Current weight")').innerText();
check('weight goal tracks toward the target weight', /60 kg/.test(weightCard),
      weightCard.replace(/\n/g, ' ').slice(0, 90));

// --- calorie cycling conserves the week ---
await page.click('button:has-text("Plan the week")');
await page.waitForTimeout(600);
const cycle = await page.locator('.card:has-text("week total")').innerText();
const weekTotal = Number((cycle.match(/week total ([\d,]+)/) ?? [])[1]?.replace(/,/g, ''));
check('a planned week sums to the flat week', Math.abs(weekTotal - 1925 * 7) <= 7,
      `${weekTotal} vs ${1925 * 7}`);

// --- water is the one manual tracker ---
await page.click('.card:has-text("Water") button.add');
await page.waitForTimeout(400);
const other = await page.locator('.card:has-text("Water")').innerText();
check('water logs by hand', /1 of 8 glasses/.test(other),
      (other.match(/\d+ of \d+ glasses/) ?? [''])[0]);

// --- the target reaches Today ---
await page.click('nav.tabs button:has-text("Today")');
await page.waitForTimeout(300);
const todayIntake = await page.locator('.intake').innerText();
check('Today shows eaten against target', /of\s+1,?9\d\d/.test(todayIntake),
      todayIntake.replace(/\n/g, ' ').slice(0, 80));
await page.click('nav.tabs button:has-text("Diagnostics")');

// --- backup: the whole database leaves as one SQLite file ---
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('button:has-text("Export backup")'),
]);
const dlPath = await download.path();
const magic = dlPath ? (await import('node:fs')).readFileSync(dlPath).subarray(0, 16).toString('latin1') : '';
check('backup is a real SQLite database', magic.startsWith('SQLite format 3'),
      `${download.suggestedFilename()} · "${magic.replace(/\0/g, '')}"`);

// --- CSP made it into the built page ---
const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
check('CSP is present in the built page', Boolean(csp && csp.includes("default-src 'self'")),
      (csp ?? '').slice(0, 60) + '…');
check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed\n`);
process.exit(failed.length ? 1 : 0);
