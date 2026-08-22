import type { Db } from './db';

/**
 * Daily totals, read straight out of v_daily_totals.
 *
 * Pending entries are EXCLUDED by the view, never summed as zero. A NULL
 * quantity counted as 0 is silent under-logging, which is the exact
 * failure this whole design exists to prevent — so a day with pending
 * entries reports a smaller number AND says why, rather than reporting a
 * confident wrong one.
 */

export interface NutrientTotal {
  nutrient: string;
  total: number;
  absError: number;
  nEntries: number;
}

export interface DayTotals {
  date: string;
  nutrients: NutrientTotal[];
  pendingCount: number;
  /** Totals are only as complete as the log. Surface it, do not hide it. */
  complete: boolean;
}

export function dayTotals(db: Db, date: string): DayTotals {
  const rows = db.all<{ nutrient: string; total: number; abs_error: number; n_entries: number }>(
    `SELECT nutrient, total, abs_error, n_entries
     FROM v_daily_totals WHERE log_date = ? ORDER BY nutrient`,
    [date],
  );
  const pending = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM log_entry
     WHERE date(eaten_at) = ? AND status <> 'resolved'`,
    [date],
  );
  const pendingCount = pending?.n ?? 0;
  return {
    date,
    nutrients: rows.map((r) => ({
      nutrient: r.nutrient,
      total: r.total,
      absError: r.abs_error,
      nEntries: r.n_entries,
    })),
    pendingCount,
    complete: pendingCount === 0,
  };
}

export interface DayEntry {
  logEntryId: number;
  eatenAt: string;
  mealSlot: string | null;
  foodName: string;
  quantity: number | null;
  unitCode: string | null;
  gramsResolved: number | null;
  status: string;
  matchMethod: string | null;
  matchScore: number | null;
  kcal: number | null;
  kcalError: number | null;
}

export function dayEntries(db: Db, date: string): DayEntry[] {
  return db.all<any>(
    `SELECT le.id                AS logEntryId,
            le.eaten_at          AS eatenAt,
            le.meal_slot         AS mealSlot,
            f.name               AS foodName,
            le.quantity          AS quantity,
            u.code               AS unitCode,
            le.grams_resolved    AS gramsResolved,
            le.status            AS status,
            le.match_method      AS matchMethod,
            le.match_score       AS matchScore,
            le.grams_resolved / 100.0 * fn.per_100g                  AS kcal,
            le.grams_resolved / 100.0 * fn.per_100g * fn.rel_error   AS kcalError
     FROM log_entry le
     JOIN food f            ON f.id = le.food_id
     LEFT JOIN unit u       ON u.id = le.unit_id
     LEFT JOIN food_nutrient fn
            ON fn.food_id = le.food_id AND fn.nutrient = 'kcal'
     WHERE date(le.eaten_at) = ?
     ORDER BY le.eaten_at`,
    [date],
  );
}

export interface PendingItem {
  id: number;
  eatenAt: string;
  foodName: string;
  said: string | null;
  status: string;
  matchMethod: string | null;
  matchScore: number | null;
}

export function pendingQueue(db: Db): PendingItem[] {
  return db.all<any>(
    `SELECT id, eaten_at AS eatenAt, food_name AS foodName, said,
            status, match_method AS matchMethod, match_score AS matchScore
     FROM v_pending_review`,
  );
}

/** Utterances with no entries and no queue position. Must always be actionable. */
export function orphanUtterances(db: Db) {
  return db.all<{ id: number; spoken_at: string; raw_text: string; entries: number }>(
    'SELECT * FROM v_orphan_utterance',
  );
}
