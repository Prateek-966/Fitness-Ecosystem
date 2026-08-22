import { chromium } from 'playwright';
const b = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const p = await (await b.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 })).newPage();
await p.goto(process.env.BASE_URL ?? 'http://localhost:4173', { waitUntil: 'networkidle' });
await p.waitForSelector('button.mic', { timeout: 20000 });

// Seed enough state for the screenshots to show something real.
await p.click('nav.tabs button:has-text("Diagnostics")');
await p.setInputFiles('.card:has-text("Foods known") input[type=file]', {
  name: 'indb.csv', mimeType: 'text/csv',
  buffer: Buffer.from([
    'food_code,food_name,energy_kcal,protein,fat,carbohydrate',
    'A001,Roti wheat,297,10.1,1.2,58.0',
    'A002,Rajma cooked,118,7.6,0.4,20.1',
    'A003,Curd whole milk,60,3.1,4.0,3.0',
  ].join('\n')),
});
await p.waitForTimeout(400);

await p.click('nav.tabs button:has-text("Measures")');
for (const [unit, grams] of [['piece', '45'], ['katori', '150'], ['glass', '200']]) {
  await p.click(`li:has-text("${unit}") button`);
  await p.fill('.sheet input[type=number]', grams);
  await p.click('.sheet button:has-text("Save")');
  await p.waitForTimeout(250);
}

const teach = async (text, food, unit) => {
  await p.click('nav.tabs button:has-text("Today")');
  await p.fill('.card input[type=text]', text);
  await p.press('.card input[type=text]', 'Enter');
  await p.waitForTimeout(250);
  await p.click('nav.tabs button:has-text("Queue")');
  if (!(await p.locator('button:has-text("Resolve")').count())) return;
  await p.click('button:has-text("Resolve")');
  await p.fill('.sheet input[type=search]', food);
  await p.waitForTimeout(250);
  await p.click('.sheet button:has-text("pick")');
  const v = await p.$eval('.sheet .row select',
    (el, u) => [...el.options].find((o) => o.textContent.trim().startsWith(u))?.value, unit);
  await p.selectOption('.sheet .row select', v);
  await p.click('.sheet button:has-text("Log and learn")');
  await p.waitForTimeout(300);
};

await teach('two rotis', 'Roti', 'piece');
await teach('one katori rajma', 'Rajma', 'katori');

await p.click('nav.tabs button:has-text("Today")');
for (const line of ['two rotis and one katori rajma', 'one glass curd']) {
  await p.fill('.card input[type=text]', line);
  await p.press('.card input[type=text]', 'Enter');
  await p.waitForTimeout(300);
}
await p.waitForTimeout(600);

const shots = {
  today: 'nav.tabs button:has-text("Today")',
  queue: 'nav.tabs button:has-text("Queue")',
  measures: 'nav.tabs button:has-text("Measures")',
  diagnostics: 'nav.tabs button:has-text("Diagnostics")',
};
for (const [name, sel] of Object.entries(shots)) {
  await p.click(sel);
  await p.waitForTimeout(350);
  await p.screenshot({ path: `docs/screens/${name}.png`, fullPage: true });
  console.log(`docs/screens/${name}.png`);
}
await b.close();
