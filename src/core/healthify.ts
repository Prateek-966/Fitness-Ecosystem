import type { Db } from './db';
import { normalise, parse } from './parse';

/**
 * Healthify import — food names, portions-as-written and timestamps ONLY.
 *
 * Their calorie figures are deliberately dropped on the floor. A different
 * food database is a step change in bias, and a step change in bias is the
 * one thing an adaptive TDEE regression cannot cancel. Six months of their
 * numbers spliced onto your numbers does not give you six months of
 * history, it gives you a broken series.
 *
 * What the history IS good for: seeding the personal index with phrases
 * you already say, and telling you when you actually eat.
 */

export interface HealthifyRow {
  eatenAt: string;      // ISO8601
  foodText: string;
  portionText?: string | null;
  mealLabel?: string | null;
}

const DROPPED_COLUMNS = [
  'calories', 'energy', 'kcal', 'cal', 'carbs', 'carbohydrate', 'protein',
  'fat', 'fibre', 'fiber', 'sugar', 'sodium',
];

export interface ImportReport {
  parsed: number;
  inserted: number;
  skippedDuplicate: number;
  droppedColumns: string[];
  dateRange: [string, string] | null;
}

/**
 * Parses a Healthify CSV export. Column names vary between their export
 * versions, so headers are matched loosely — but nutrient columns are
 * matched just as carefully, because the point is to be sure they were
 * dropped rather than to hope they were absent.
 */
export function parseHealthifyCsv(csv: string): { rows: HealthifyRow[]; dropped: string[] } {
  const lines = splitCsvLines(csv).filter((l) => l.some((c) => c.trim() !== ''));
  if (lines.length < 2) return { rows: [], dropped: [] };

  const header = lines[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.findIndex((h) => h === n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = header.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iDate = col('date', 'day');
  const iTime = col('time', 'logged at', 'timestamp');
  const iFood = col('food', 'item', 'food name', 'name');
  const iPortion = col('portion', 'quantity', 'serving', 'amount', 'measure');
  const iMeal = col('meal', 'meal type', 'slot');

  const dropped = header.filter((h) => DROPPED_COLUMNS.some((d) => h.includes(d)));

  const rows: HealthifyRow[] = [];
  for (const cells of lines.slice(1)) {
    const food = iFood >= 0 ? cells[iFood]?.trim() : '';
    if (!food) continue;
    const eatenAt = toIso(
      iDate >= 0 ? cells[iDate] : '',
      iTime >= 0 ? cells[iTime] : '',
    );
    if (!eatenAt) continue;
    rows.push({
      eatenAt,
      foodText: food,
      portionText: iPortion >= 0 ? (cells[iPortion]?.trim() || null) : null,
      mealLabel: iMeal >= 0 ? (cells[iMeal]?.trim() || null) : null,
    });
  }
  return { rows, dropped };
}

function toIso(dateCell = '', timeCell = ''): string | null {
  const d = dateCell.trim();
  const t = timeCell.trim();
  if (!d && !t) return null;
  // Their exports use dd/mm/yyyy and yyyy-mm-dd depending on locale.
  let iso: string | null = null;
  const dmy = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(d);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (ymd) iso = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  else if (dmy) iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  if (!iso) return null;

  let time = '00:00:00';
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(t);
  if (hm) {
    let h = parseInt(hm[1], 10);
    const ap = hm[4]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    time = `${String(h).padStart(2, '0')}:${hm[2]}:${hm[3] ?? '00'}`;
  }
  return `${iso}T${time}`;
}

function splitCsvLines(csv: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}

export function importHealthify(db: Db, rows: HealthifyRow[], dropped: string[] = []): ImportReport {
  let inserted = 0;
  let dup = 0;
  const now = new Date().toISOString();

  db.tx(() => {
    for (const r of rows) {
      const res = db.run(
        `INSERT OR IGNORE INTO imported_entry
           (source, eaten_at, food_text, portion_text, meal_label, imported_at)
         VALUES ('healthify', ?, ?, ?, ?, ?)`,
        [r.eatenAt, r.foodText, r.portionText ?? null, r.mealLabel ?? null, now],
      );
      if (res.changes > 0) inserted++; else dup++;
    }
  });

  const range = db.get<{ lo: string; hi: string }>(
    "SELECT MIN(eaten_at) AS lo, MAX(eaten_at) AS hi FROM imported_entry WHERE source = 'healthify'",
  );

  return {
    parsed: rows.length,
    inserted,
    skippedDuplicate: dup,
    droppedColumns: dropped,
    dateRange: range?.lo ? [range.lo, range.hi] : null,
  };
}

export interface PhraseCandidate {
  phrase: string;
  occurrences: number;
  suggestedQty: number | null;
  suggestedUnit: string | null;
  known: boolean;
}

/**
 * The phrases you already say, ranked by how often you said them.
 *
 * These are CANDIDATES, not index entries. Nothing here is written to
 * phrase_index automatically: an imported name is a string from someone
 * else's database, and binding it to a food is a food-identity decision.
 * Food-identity decisions are the ones that must never be guessed.
 */
export function phraseCandidates(db: Db, limit = 100): PhraseCandidate[] {
  const rows = db.all<{ food_text: string; portion_text: string | null; n: number }>(
    `SELECT food_text, portion_text, COUNT(*) AS n
     FROM imported_entry
     GROUP BY food_text, portion_text
     ORDER BY n DESC`,
  );

  const agg = new Map<string, PhraseCandidate>();
  for (const r of rows) {
    const parsed = parse(`${r.portion_text ?? ''} ${r.food_text}`.trim());
    const item = parsed[0];
    const phrase = item ? item.phrase : normalise(r.food_text);
    if (!phrase) continue;

    const existing = agg.get(phrase);
    if (existing) {
      existing.occurrences += r.n;
      continue;
    }
    agg.set(phrase, {
      phrase,
      occurrences: r.n,
      suggestedQty: item?.quantity ?? null,
      suggestedUnit: item?.unitCode ?? null,
      known: false,
    });
  }

  const out = [...agg.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, limit);
  for (const c of out) {
    const hit = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM phrase_index WHERE phrase = ?', [c.phrase],
    );
    c.known = (hit?.n ?? 0) > 0;
  }
  return out;
}
