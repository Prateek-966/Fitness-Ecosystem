/**
 * Load food reference data.
 *
 *   npm run load-indb -- data/indb.csv
 *   npm run load-indb -- data/ifct2017.csv --source ifct2017
 *
 * INDB (Indian Nutrient Databank) is the intended primary source: open
 * access, ~1,095 items plus ~1,014 recipes with ingredient decomposition.
 *
 * IFCT 2017 is personal-use licensed. Load it locally if you want it as a
 * reference, but data/ is gitignored and it must stay that way — do not
 * commit anything derived from it.
 *
 * No data file ships with this repo, by design.
 */
import { readFileSync } from 'node:fs';
import { openCliDb, arg, positional } from './_open';
import { loadFoods, parseFoodCsv, type FoodSource } from '../src/core/foodimport';

const path = positional(0);
if (!path) {
  console.error('usage: npm run load-indb -- <csv> [--source indb|ifct2017|usda_fdc|label]');
  console.error('\nNo food data is bundled. Point this at a CSV you have obtained yourself.');
  process.exit(1);
}

const source = (arg('source') ?? 'indb') as FoodSource;
const relError = arg('rel-error') ? Number(arg('rel-error')) : undefined;

const { records, unmapped } = parseFoodCsv(readFileSync(path, 'utf8'));
if (records.length === 0) {
  console.error(`No usable rows in ${path}. Expected a food name column and at least one nutrient column.`);
  process.exit(1);
}

const db = openCliDb();
const report = loadFoods(db, records, source, relError);

console.log(`${path} -> ${source}`);
console.log(`  ${report.inserted} inserted, ${report.updated} updated`);
console.log(`  ${report.nutrientRows} nutrient values, rel_error ${relError ?? 'source default'}`);
if (report.skipped.length) {
  console.log(`  ${report.skipped.length} skipped (no energy value): ${report.skipped.slice(0, 5).join(', ')}${report.skipped.length > 5 ? '…' : ''}`);
}
if (unmapped.length) console.log(`  ignored columns: ${unmapped.join(', ')}`);
db.close();
