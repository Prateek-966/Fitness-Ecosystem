/**
 * Import a Garmin Connect CSV export.
 *
 *   npm run import-garmin -- data/activities.csv
 *   npm run import-garmin -- data/wellness.csv
 *
 * Activities or wellness — the format is detected from the headers.
 *
 * This is file import by design. Connecting to Garmin's API needs an OAuth
 * client secret and a webhook endpoint, which means a server holding a
 * token and seeing your health data in transit. That is a steep price for
 * data that arrives once a day.
 */
import { readFileSync } from 'node:fs';
import { openCliDb, positional } from './_open';
import { importGarminCsv, sourceCoverage } from '../src/core/garmin';

const path = positional(0);
if (!path) {
  console.error('usage: npm run import-garmin -- <csv>');
  process.exit(1);
}

const db = openCliDb();
const r = importGarminCsv(db, readFileSync(path, 'utf8'));

console.log(`${path}`);
if (r.activitiesParsed) {
  console.log(`  ${r.activitiesInserted} new workouts of ${r.activitiesParsed} parsed`);
  console.log(`  ${r.energyRows} garmin energy values (stored as their own estimate, never summed)`);
}
if (r.daysParsed) console.log(`  ${r.metricRows} daily values over ${r.daysParsed} days`);
if (r.dateRange) console.log(`  range: ${r.dateRange[0]} .. ${r.dateRange[1]}`);
if (r.skipped.length) console.log(`  skipped ${r.skipped.length}: ${r.skipped.slice(0, 5).join(', ')}`);
if (r.unmapped.length) console.log(`  ignored columns: ${r.unmapped.join(', ')}`);

const cov = sourceCoverage(db);
if (cov.length) {
  console.log('\nSource coverage — where one series ends and another begins:');
  for (const c of cov) {
    console.log(`  ${c.series.padEnd(18)} ${c.source.padEnd(13)} ${c.first_seen} .. ${c.last_seen}  (n=${c.n})`);
  }
  console.log('\nStarting a new source partway through a series is a step change in');
  console.log('measurement regime, and that is the one thing the TDEE model cannot');
  console.log('cancel out. Worth knowing before you fit anything across that line.');
}
db.close();
