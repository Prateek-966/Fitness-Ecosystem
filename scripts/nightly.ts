/**
 * Nightly pass: recompute daily_logging_stats.
 *
 * This is the bias-drift detector. It is not about totals — it is about
 * whether each day was logged the same WAY as the days around it, because
 * a stable systematic error cancels out of the model and a wandering one
 * does not.
 */
import { openCliDb } from './_open';
import { refreshAllStats } from '../src/core/stats';

const db = openCliDb();
const n = refreshAllStats(db);
console.log(`recomputed stats for ${n} day(s)`);

const excluded = db.all<{ log_date: string; pending_count: number; entry_count: number }>(
  'SELECT log_date, pending_count, entry_count FROM v_model_excluded_days ORDER BY log_date DESC LIMIT 10',
);
if (excluded.length) {
  console.log('\nDays excluded from the model:');
  for (const d of excluded) {
    console.log(`  ${d.log_date}  ${d.entry_count} entries, ${d.pending_count} pending`);
  }
}
db.close();
