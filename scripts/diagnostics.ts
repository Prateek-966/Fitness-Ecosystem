/** The acceptance criteria, read out of the tables that recorded them. */
import { openCliDb } from './_open';
import { diagnostics } from '../src/core/stats';

const db = openCliDb();
const d = diagnostics(db);

const line = (n: number, text: string, value: string, met: boolean | null) =>
  console.log(`  ${met === null ? '·' : met ? '✓' : '×'} ${n}. ${text.padEnd(44)} ${value}`);

console.log(`Diagnostics over the last ${d.days} days\n`);
line(1, 'Known repeat meal under 3 s',
     `median ${fmtMs(d.medianCaptureMs)}, p90 ${fmtMs(d.p90CaptureMs)}`,
     d.underTargetFraction === null ? null : d.underTargetFraction >= 0.9);
line(2, 'Fast-path fraction above 0.8', pct(d.fastpathFraction),
     d.fastpathFraction === null ? null : d.fastpathFraction > 0.8);
line(3, 'Zero logs lost',
     `${d.lostUtterances} lost, ${d.queuedUtterances} queued`, d.lostUtterances === 0);
line(4, 'Pending queue clearable in a minute', `${d.openPending} open`, d.openPending <= 10);
line(5, '30 consecutive days', `${d.currentStreakDays} day streak`, d.currentStreakDays >= 30);

console.log('\nMatch decisions closest to the threshold (tune with these, not with vibes):');
const review = db.all<any>('SELECT * FROM v_match_review LIMIT 10');
if (!review.length) console.log('  (no fuzzy decisions yet)');
for (const r of review) {
  console.log(`  ${r.accepted ? 'took' : 'left'} "${r.phrase}" -> ${r.chosen_food ?? r.chosen_phrase ?? '—'}  `
    + `score ${r.score?.toFixed(3)} (threshold ${r.threshold}, margin ${r.margin?.toFixed(3)})`);
}
db.close();

function fmtMs(n: number | null) { return n === null ? '—' : `${Math.round(n)} ms`; }
function pct(n: number | null) { return n === null ? '—' : `${Math.round(n * 100)}%`; }
