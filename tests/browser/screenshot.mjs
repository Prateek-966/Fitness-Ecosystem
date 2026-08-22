/**
 * Capture the docs screenshots against a real build.
 *
 * Everything here goes through the UI as a person would: load food data,
 * calibrate measures, import a history so meal windows derive, teach a
 * few phrases through the slow path, then log into each meal section
 * using its own + button. Nothing is written to the database directly,
 * so what the screenshots show is what the app actually does.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const p = await (await browser.newContext({
  viewport: { width: 420, height: 900 }, deviceScaleFactor: 2,
})).newPage();

await p.goto(process.env.BASE_URL ?? 'http://localhost:4173', { waitUntil: 'networkidle' });
await p.waitForSelector('button.mic', { timeout: 20000 });

// ---- food reference data ----
await p.click('nav.tabs button:has-text("Diagnostics")');
await p.setInputFiles('.card:has-text("Foods known") input[type=file]', {
  name: 'indb.csv', mimeType: 'text/csv',
  buffer: Buffer.from([
    'food_code,food_name,energy_kcal,protein,fat,carbohydrate',
    'A001,Roti wheat,297,10.1,1.2,58.0',
    'A002,Rajma cooked,118,7.6,0.4,20.1',
    'A003,Curd whole milk,60,3.1,4.0,3.0',
    'A004,Poha,130,2.6,3.1,23.0',
    'A005,Almonds,579,21.2,49.9,21.6',
  ].join('\n')),
});
await p.waitForTimeout(400);

// ---- history, so meal windows derive from real behaviour ----
const history = ['Date,Time,Meal,Food Name,Portion'];
for (const day of ['20/08/2026', '21/08/2026', '22/08/2026']) {
  history.push(`${day},08:15,Breakfast,Poha,1 katori`);
  history.push(`${day},13:20,Lunch,Rajma,1 katori`);
  history.push(`${day},17:30,Snack,Almonds,10 pieces`);
  history.push(`${day},20:45,Dinner,Roti,2 pieces`);
}
await p.setInputFiles('.card:has-text("Healthify CSV export") input[type=file]', {
  name: 'healthify.csv', mimeType: 'text/csv', buffer: Buffer.from(history.join('\n')),
});
await p.waitForTimeout(500);

// ---- calibrate the measures ----
await p.click('nav.tabs button:has-text("Measures")');
for (const [unit, grams] of [['piece', '45'], ['katori', '150'], ['glass', '200']]) {
  await p.click(`li:has-text("${unit}") button`);
  await p.fill('.sheet input[type=number]', grams);
  await p.click('.sheet button:has-text("Save")');
  await p.waitForTimeout(250);
}

/** Log a phrase, then resolve it through the slow path so it is learned. */
const teach = async (text, food, unit) => {
  await p.click('nav.tabs button:has-text("Today")');
  await p.fill('.capture input[type=text]', text);
  await p.press('.capture input[type=text]', 'Enter');
  await p.waitForTimeout(300);
  await p.click('nav.tabs button:has-text("Queue")');
  if (!(await p.locator('button:has-text("Resolve")').count())) return;
  await p.click('button:has-text("Resolve")');
  await p.fill('.sheet input[type=search]', food);
  await p.waitForTimeout(250);
  await p.click('.sheet button:has-text("pick")');
  const value = await p.$eval('.sheet .row select',
    (el, u) => [...el.options].find((o) => o.textContent.trim().startsWith(u))?.value, unit);
  await p.selectOption('.sheet .row select', value);
  await p.click('.sheet button:has-text("Log and learn")');
  await p.waitForTimeout(300);
};

await teach('two rotis', 'Roti', 'piece');
await teach('one katori rajma', 'Rajma', 'katori');
await teach('one glass curd', 'Curd', 'glass');
await teach('one katori poha', 'Poha', 'katori');

/**
 * Log into a named meal using that section's + button. This is the
 * feature under test as much as it is stage dressing: an entry filed to
 * breakfast at midday is a normal thing to want.
 */
const logInto = async (meal, text) => {
  await p.click('nav.tabs button:has-text("Today")');
  const section = p.locator('.card.meal', { hasText: meal }).first();
  if (!(await section.count())) return;
  await section.locator('button.add').click();
  await p.waitForTimeout(200);
  await p.fill('.capture input[type=text]', text);
  await p.press('.capture input[type=text]', 'Enter');
  await p.waitForTimeout(350);
};

await logInto('Breakfast', 'one katori poha');
await logInto('Lunch', 'two rotis and one katori rajma');
await logInto('Snack', 'one glass curd');
await logInto('Dinner', 'two rotis and one katori rajma');
await p.waitForTimeout(700);

const shots = {
  today: 'nav.tabs button:has-text("Today")',
  queue: 'nav.tabs button:has-text("Queue")',
  measures: 'nav.tabs button:has-text("Measures")',
  diagnostics: 'nav.tabs button:has-text("Diagnostics")',
};
for (const [name, selector] of Object.entries(shots)) {
  await p.click(selector);
  await p.waitForTimeout(400);
  await p.screenshot({ path: `docs/screens/${name}.png`, fullPage: true });
  console.log(`docs/screens/${name}.png`);
}
await browser.close();
