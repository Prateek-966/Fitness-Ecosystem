/**
 * Import Healthify history.
 *
 *   npm run import-healthify -- exports/healthify.csv
 *
 * Food names, portions as written, and timestamps. Their calorie figures
 * are dropped: a different food database is a step change in bias, and a
 * step change in bias is the one thing an adaptive TDEE model cannot
 * cancel out. The history is for seeding your phrase index and for
 * learning when you actually eat — not for its numbers.
 */
import { readFileSync } from 'node:fs';
import { openCliDb, positional } from './_open';
import { importHealthify, parseHealthifyCsv, phraseCandidates } from '../src/core/healthify';
import { refreshWindows } from '../src/core/mealslot';

const path = positional(0);
if (!path) {
  console.error('usage: npm run import-healthify -- <csv>');
  process.exit(1);
}

const { rows, dropped } = parseHealthifyCsv(readFileSync(path, 'utf8'));
const db = openCliDb();
const report = importHealthify(db, rows, dropped);

console.log(`${report.inserted} imported, ${report.skippedDuplicate} already present`);
if (report.dateRange) console.log(`  range: ${report.dateRange[0].slice(0, 10)} .. ${report.dateRange[1].slice(0, 10)}`);
if (dropped.length) console.log(`  dropped nutrient columns: ${dropped.join(', ')}`);

const windows = refreshWindows(db, 'imported_entry');
if (windows.length) {
  console.log('\nMeal slots derived from when you actually log:');
  for (const w of windows) {
    console.log(`  ${w.slot.padEnd(10)} ${hhmm(w.startMin)}–${hhmm(w.endMin)}  centre ${hhmm(w.centreMin)}  (n=${w.nObservations})`);
  }
}

const cands = phraseCandidates(db, 15);
if (cands.length) {
  console.log('\nMost common phrases, ready to seed the index:');
  for (const c of cands) {
    const known = c.known ? ' [known]' : '';
    const qty = c.suggestedQty ? ` — usually ${c.suggestedQty}${c.suggestedUnit ? ` ${c.suggestedUnit}` : ''}` : '';
    console.log(`  ${String(c.occurrences).padStart(4)}x  ${c.phrase}${qty}${known}`);
  }
  console.log('\nNone of these were bound to a food. Binding a name from someone else\'s');
  console.log('database to a food is a food-identity decision, and those are never guessed.');
}

db.close();

function hhmm(m: number): string {
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
}
