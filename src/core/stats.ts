import type { Db } from './db';
import { localDate } from './clock';

/**
 * daily_logging_stats — the bias-drift detector.
 *
 * Systematic error is fine if it is STABLE. The TDEE regression cancels a
 * constant bias and cannot cancel a wandering one. So the thing worth
 * measuring is not how accurate a day was, it is whether the day was
 * logged the same WAY as the days around it.
 *
 * Run nightly. Idempotent — recomputing a day is always safe.
 */

export interface DayStats {
  logDate: string;
  entryCount: number;
  pendingCount: number;
  weighedFraction: number | null;
  fastpathFraction: number | null;
  outsideFoodCount: number;
  firstLogAt: string | null;
  lastLogAt: string | null;
  modelEligible: boolean;
}

export function computeDayStats(db: Db, date: string): DayStats {
  const base = db.get<any>(
    `SELECT COUNT(*)                                              AS entry_count,
            SUM(CASE WHEN status <> 'resolved' THEN 1 ELSE 0 END) AS pending_count,
            MIN(created_at)                                       AS first_log_at,
            MAX(created_at)                                       AS last_log_at
     FROM log_entry WHERE date(eaten_at) = ?`,
    [date],
  )!;

  const entryCount = base.entry_count ?? 0;
  const pendingCount = base.pending_count ?? 0;

  // Share of resolved entries whose grams came from a measure the user
  // actually put on a scale, rather than one they estimated or an
  // absolute unit they spoke directly.
  // The basis of the measure that actually resolved the entry — the same
  // precedence toGrams uses (food-specific first, then latest). A LEFT
  // JOIN here would fan out when both a general and a food-specific
  // calibration exist for one unit, counting a single entry twice in both
  // numerator and denominator and quietly skewing the fraction.
  const weighed = db.get<{ weighed: number; total: number }>(
    `SELECT SUM(CASE WHEN u.is_absolute = 1 OR (
              SELECT um.basis FROM user_measure um
              WHERE um.unit_id = le.unit_id
                AND (um.food_id = le.food_id OR um.food_id IS NULL)
              ORDER BY um.food_id IS NULL, um.calibrated_at DESC LIMIT 1
            ) = 'weighed' THEN 1 ELSE 0 END) AS weighed,
            COUNT(*)                         AS total
     FROM log_entry le
     JOIN unit u ON u.id = le.unit_id
     WHERE date(le.eaten_at) = ? AND le.status = 'resolved'`,
    [date],
  );

  // Share that never left the device index. This is acceptance criterion 2.
  const fast = db.get<{ fast: number; total: number }>(
    `SELECT SUM(CASE WHEN match_method = 'exact_index' THEN 1 ELSE 0 END) AS fast,
            COUNT(*)                                                     AS total
     FROM log_entry WHERE date(eaten_at) = ?`,
    [date],
  );

  // A run of restaurant meals is a change of measurement regime, not a
  // change of metabolism. Counted here so the model can see it coming.
  const outside = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM log_entry le
     JOIN food f ON f.id = le.food_id
     WHERE date(le.eaten_at) = ? AND f.brand IS NOT NULL`,
    [date],
  );

  const weighedFraction = weighed && weighed.total > 0 ? weighed.weighed / weighed.total : null;
  const fastpathFraction = fast && fast.total > 0 ? fast.fast / fast.total : null;

  return {
    logDate: date,
    entryCount,
    pendingCount,
    weighedFraction,
    fastpathFraction,
    outsideFoodCount: outside?.n ?? 0,
    firstLogAt: base.first_log_at ?? null,
    lastLogAt: base.last_log_at ?? null,
    // A day with any pending entry is under-logged by a known amount.
    // Under-logged by a known amount is still under-logged: exclude it
    // rather than feed the regression a number that is quietly low.
    modelEligible: entryCount > 0 && pendingCount === 0,
  };
}

export function writeDayStats(db: Db, date: string): DayStats {
  const s = computeDayStats(db, date);
  db.run(
    `INSERT INTO daily_logging_stats
       (log_date, entry_count, pending_count, weighed_fraction, fastpath_fraction,
        outside_food_count, first_log_at, last_log_at, model_eligible)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(log_date) DO UPDATE SET
       entry_count        = excluded.entry_count,
       pending_count      = excluded.pending_count,
       weighed_fraction   = excluded.weighed_fraction,
       fastpath_fraction  = excluded.fastpath_fraction,
       outside_food_count = excluded.outside_food_count,
       first_log_at       = excluded.first_log_at,
       last_log_at        = excluded.last_log_at,
       model_eligible     = excluded.model_eligible`,
    [
      s.logDate, s.entryCount, s.pendingCount, s.weighedFraction, s.fastpathFraction,
      s.outsideFoodCount, s.firstLogAt, s.lastLogAt, s.modelEligible ? 1 : 0,
    ],
  );
  return s;
}

/** Nightly pass. Recomputes every day that has entries but no current row. */
export function refreshAllStats(db: Db): number {
  const dates = db.all<{ d: string }>(
    'SELECT DISTINCT date(eaten_at) AS d FROM log_entry ORDER BY d',
  );
  for (const { d } of dates) writeDayStats(db, d);
  return dates.length;
}

/**
 * Acceptance criteria, measured rather than estimated. Every number here
 * comes out of a table, not out of a guess.
 */
export interface Diagnostics {
  days: number;
  medianCaptureMs: number | null;
  p90CaptureMs: number | null;
  underTargetFraction: number | null;
  fastpathFraction: number | null;
  /** Utterances sitting visibly in the queue. Not a failure — a to-do. */
  queuedUtterances: number;
  /**
   * Utterances marked done with nothing to show for them: no entries, no
   * undo, no queue position. This is the number criterion 3 is actually
   * about, and it must always be zero.
   */
  lostUtterances: number;
  openPending: number;
  currentStreakDays: number;
}

export function diagnostics(db: Db, windowDays = 14): Diagnostics {
  const since = localDate(new Date(Date.now() - windowDays * 86400_000));
  const target = db.get<{ value: string }>(
    "SELECT value FROM app_setting WHERE key = 'target_capture_ms'",
  );
  const targetMs = target ? Number(target.value) : 3000;

  const timings = db.all<{ total_ms: number }>(
    `SELECT ct.total_ms FROM capture_timing ct
     JOIN utterance u ON u.id = ct.utterance_id
     WHERE date(u.spoken_at) >= ? AND ct.fast_path = 1
     ORDER BY ct.total_ms`,
    [since],
  ).map((r) => r.total_ms);

  const pick = (frac: number) =>
    timings.length ? timings[Math.min(timings.length - 1, Math.floor(frac * timings.length))] : null;

  const fast = db.get<{ fast: number; total: number }>(
    `SELECT SUM(CASE WHEN match_method = 'exact_index' THEN 1 ELSE 0 END) AS fast,
            COUNT(*) AS total
     FROM log_entry WHERE date(eaten_at) >= ?`,
    [since],
  );

  const queued = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM v_orphan_utterance')!;
  const lost = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM utterance u
     WHERE u.processed_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM log_entry le WHERE le.utterance_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM undone_utterance x WHERE x.utterance_id = u.id)`,
  )!;
  const openPending = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM log_entry WHERE status <> 'resolved'",
  )!;

  return {
    days: windowDays,
    medianCaptureMs: pick(0.5),
    p90CaptureMs: pick(0.9),
    underTargetFraction: timings.length
      ? timings.filter((t) => t <= targetMs).length / timings.length
      : null,
    fastpathFraction: fast && fast.total > 0 ? fast.fast / fast.total : null,
    queuedUtterances: queued.n,
    lostUtterances: lost.n,
    openPending: openPending.n,
    currentStreakDays: loggingStreak(db),
  };
}

/** Criterion 5: consecutive days used. The only one that actually matters. */
export function loggingStreak(db: Db): number {
  const days = new Set(
    db.all<{ d: string }>('SELECT DISTINCT date(spoken_at) AS d FROM utterance').map((r) => r.d),
  );
  if (days.size === 0) return 0;
  let streak = 0;
  const cursor = new Date();
  // Local calendar days: a streak is about evenings and mornings as the
  // user lives them, not as UTC slices them. Today not being logged yet
  // does not break a streak that is still live.
  if (!days.has(localDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(localDate(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
