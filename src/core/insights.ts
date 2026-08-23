import type { Db } from './db.ts';
import { localDate } from './clock.ts';

/**
 * The cross-day query layer.
 *
 * Until this file, the application recorded everything and aggregated
 * almost nothing: `v_daily_totals` was only ever read one date at a
 * time. Every question the owner actually wants answered - "how much do
 * I normally eat on training days", "why has my weight stopped
 * dropping", "what does my normal week look like" - is a question about
 * a SPAN of days, and there was no code that asked one.
 *
 * Two rules hold throughout, both inherited rather than invented:
 *
 *  - A missing measurement is missing. Every function here reports the
 *    number of observations it had, and returns null rather than a
 *    figure derived from two data points. An average over four days is
 *    not a habit.
 *  - Every number carries its working. Each result includes a `basis`
 *    in words, for the same reason `energy_target.basis` exists: a
 *    figure found six months from now must still explain itself.
 */

const daysAgo = (n: number, from = new Date()): string => {
  const d = new Date(from);
  d.setDate(d.getDate() - n);
  return localDate(d);
};

const round = (v: number, dp = 1): number => Number(v.toFixed(dp));

// ------------------------------------------------------------------
// Weight
// ------------------------------------------------------------------

export interface WeightTrend {
  kgPerWeek: number;
  currentKg: number;
  nReadings: number;
  spanDays: number;
  /** How well a straight line fits. Low means the weight is noisy. */
  r2: number;
  /**
   * Standard error of the rate, in kg/week. This is what makes a
   * projection honest: -0.32 +/- 0.05 and -0.32 +/- 0.40 are the same
   * number and completely different facts.
   */
  seKgPerWeek: number;
  /** Intercept and slope per day, kept so a projection need not refit. */
  fit: { interceptKg: number; slopePerDay: number; lastX: number };
  basis: string;
}

/**
 * Rate of change from a least-squares fit over the weight series.
 *
 * `weightProgress()` in energy.ts answers "how far have I come" by
 * comparing the first reading to the last. That is the right answer to
 * that question and the wrong one to this: two readings a month apart
 * cannot tell a steady loss from a plateau that followed a drop, and a
 * plateau is precisely what the owner wants to detect.
 *
 * Daily weight moves kilograms on water alone, so a single pair of
 * readings is nearly meaningless and the slope needs the whole series.
 * r2 is returned rather than hidden: a confident-looking rate from a
 * scatter that a line does not describe is exactly the sort of number
 * this application refuses to emit unqualified.
 */
export function weightTrend(db: Db, days = 28, today = localDate()): WeightTrend | null {
  const rows = db.all<{ recorded_at: string; weight_kg: number }>(
    `SELECT recorded_at, weight_kg FROM body_profile
      WHERE date(recorded_at) >= ? AND date(recorded_at) <= ?
      ORDER BY recorded_at ASC`,
    [daysAgo(days, new Date(`${today}T12:00:00`)), today],
  );
  // Three points is the fewest that can distinguish a trend from a pair
  // of readings joined by a line.
  if (rows.length < 3) return null;

  const t0 = Date.parse(`${rows[0].recorded_at.slice(0, 10)}T00:00:00`);
  const xs = rows.map((r) => (Date.parse(`${r.recorded_at.slice(0, 10)}T00:00:00`) - t0) / 86400_000);
  const ys = rows.map((r) => r.weight_kg);
  const spanDays = xs[xs.length - 1];
  if (spanDays <= 0) return null;

  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slopePerDay = sxy / sxx;
  const intercept = my - slopePerDay * mx;
  const r2 = syy === 0 ? 1 : round((sxy * sxy) / (sxx * syy), 3);

  // Residual standard error, then the standard error of the slope.
  // n - 2 because two parameters were fitted.
  let ssr = 0;
  for (let i = 0; i < n; i++) ssr += (ys[i] - (intercept + slopePerDay * xs[i])) ** 2;
  const sigma = n > 2 ? Math.sqrt(ssr / (n - 2)) : 0;
  const seSlopePerDay = sxx > 0 ? sigma / Math.sqrt(sxx) : 0;

  return {
    kgPerWeek: round(slopePerDay * 7, 2),
    currentKg: ys[ys.length - 1],
    nReadings: n,
    spanDays: round(spanDays, 0),
    r2,
    seKgPerWeek: round(seSlopePerDay * 7, 3),
    fit: { interceptKg: intercept, slopePerDay, lastX: xs[xs.length - 1] },
    basis: `${n} readings over ${Math.round(spanDays)} days`,
  };
}

// ------------------------------------------------------------------
// Stage 3: prediction
// ------------------------------------------------------------------

export interface Projection {
  weeks: number;
  /** Central estimate. */
  kg: number;
  /** 95% interval on the RATE, carried forward. */
  lowKg: number;
  highKg: number;
  basis: string;
}

export interface GoalArrival {
  /** Weeks at the OBSERVED rate. Null if not heading there at all. */
  weeksAtCurrentRate: number | null;
  /** Weeks at the rate you asked for. */
  weeksAtIntendedRate: number | null;
  goalKg: number;
  /** True when the observed rate is going the wrong way entirely. */
  movingAway: boolean;
  basis: string;
}

/**
 * "If you continue like this, here is where you end up."
 *
 * Returned as an interval, never a point. A projection from a rate of
 * -0.32 +/- 0.05 kg/week and one from -0.32 +/- 0.40 are the same
 * number and completely different facts, and an app whose whole claim
 * is honest error bars must not quietly drop the second one.
 *
 * The interval widens with distance, because it is the uncertainty in
 * the RATE compounding - being unsure of a slope costs more the further
 * you extrapolate it, which is exactly why long projections here are
 * nearly useless and should look it.
 */
export function project(db: Db, weeks: number, today = localDate()): Projection | null {
  const trend = weightTrend(db, 28, today);
  if (trend === null) return null;

  const central = trend.currentKg + trend.kgPerWeek * weeks;
  // 1.96 standard errors, carried forward the same number of weeks.
  const spread = 1.96 * trend.seKgPerWeek * weeks;

  return {
    weeks,
    kg: round(central, 1),
    lowKg: round(central - Math.abs(spread), 1),
    highKg: round(central + Math.abs(spread), 1),
    basis: `${trend.kgPerWeek} +/- ${round(1.96 * trend.seKgPerWeek, 2)} kg/week from ${trend.basis}`,
  };
}

/** When you actually arrive, at the rate you are actually going. */
export function goalArrival(db: Db, today = localDate()): GoalArrival | null {
  const trend = weightTrend(db, 28, today);
  const goal = db.get<{ goal_weight_kg: number | null; goal_rate_kg_per_week: number }>(
    `SELECT goal_weight_kg, goal_rate_kg_per_week
       FROM body_profile ORDER BY recorded_at DESC, id DESC LIMIT 1`);
  if (!trend || !goal?.goal_weight_kg) return null;

  const remaining = goal.goal_weight_kg - trend.currentKg;
  const sameDirection = (r: number) => r !== 0 && Math.sign(remaining) === Math.sign(r);

  return {
    goalKg: goal.goal_weight_kg,
    weeksAtCurrentRate: sameDirection(trend.kgPerWeek)
      ? round(remaining / trend.kgPerWeek, 1) : null,
    weeksAtIntendedRate: sameDirection(goal.goal_rate_kg_per_week)
      ? round(remaining / goal.goal_rate_kg_per_week, 1) : null,
    movingAway: trend.kgPerWeek !== 0 && !sameDirection(trend.kgPerWeek)
      && Math.abs(remaining) > 0.1,
    basis: trend.basis,
  };
}

// ------------------------------------------------------------------
// Intake over a span
// ------------------------------------------------------------------

export interface NutrientHabit {
  nutrient: string;
  meanPerDay: number;
  nDays: number;
  /** Null when no target is set for this nutrient. */
  targetPerDay: number | null;
  /** Mean as a share of target. Null without a target. */
  adherence: number | null;
  basis: string;
}

/**
 * What you actually eat, per day, over a window - against what you said
 * you wanted.
 *
 * This is the difference between "protein was low yesterday" (already
 * answerable) and "protein is historically low" (was not).
 *
 * Days with no log at all are excluded rather than counted as zero. A
 * day you did not log is a day with no data, not a day you ate nothing,
 * and averaging zeros in would make every gap look like restraint.
 */
export function nutrientHabits(
  db: Db, days = 28, today = localDate(),
): NutrientHabit[] {
  const from = daysAgo(days, new Date(`${today}T12:00:00`));
  const rows = db.all<{ nutrient: string; mean_total: number; n_days: number }>(
    `SELECT nutrient, AVG(total) AS mean_total, COUNT(*) AS n_days
       FROM (SELECT log_date, nutrient, SUM(total) AS total
               FROM v_daily_totals
              WHERE log_date >= ? AND log_date <= ?
              GROUP BY log_date, nutrient)
      GROUP BY nutrient
      ORDER BY nutrient`,
    [from, today],
  );

  const targets = nutrientTargets(db, today);
  return rows.map((r) => {
    const target = targets[r.nutrient] ?? null;
    return {
      nutrient: r.nutrient,
      meanPerDay: round(r.mean_total),
      nDays: r.n_days,
      targetPerDay: target === null ? null : round(target),
      adherence: target === null || target === 0 ? null : round(r.mean_total / target, 3),
      basis: `mean of ${r.n_days} logged days in the last ${days}`,
    };
  });
}

/**
 * Daily targets by nutrient, derived from the same settings the Today
 * screen uses. Read here rather than duplicated, so the two can never
 * disagree about what the goal is.
 */
function nutrientTargets(db: Db, today: string): Record<string, number> {
  const kcal = db.get<{ kcal: number }>(
    'SELECT kcal FROM v_energy_target WHERE log_date = ?', [today])?.kcal;
  if (kcal === undefined) return {};

  const setting = (key: string, fallback: number): number => {
    const v = db.get<{ value: string }>(
      'SELECT value FROM app_setting WHERE key = ?', [key])?.value;
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // 4 kcal/g protein and carbohydrate, 9 kcal/g fat - Atwater factors,
  // the same ones the macro budget screen uses.
  return {
    // 'kcal' is the canonical key - foodimport.ts normalises every
    // spelling an export might use onto it. Using any other name here
    // would silently return no rows rather than fail.
    kcal,
    protein_g: (kcal * setting('macro_protein_pct', 20) / 100) / 4,
    carb_g: (kcal * setting('macro_carb_pct', 50) / 100) / 4,
    fat_g: (kcal * setting('macro_fat_pct', 30) / 100) / 9,
    fibre_g: (kcal / 1000) * setting('fibre_g_per_1000kcal', 14),
  };
}

// ------------------------------------------------------------------
// Behaviour: training days, and the shape of a week
// ------------------------------------------------------------------

export interface SplitIntake {
  onKcal: number | null;
  offKcal: number | null;
  nOn: number;
  nOff: number;
  differenceKcal: number | null;
  basis: string;
}

/**
 * "How much do I normally eat on training days?"
 *
 * A training day is one with a workout session, not one the calorie
 * plan called hard - the plan is a decision, and this is a measurement
 * of what happened.
 */
export function trainingDayIntake(
  db: Db, days = 28, today = localDate(),
): SplitIntake {
  const from = daysAgo(days, new Date(`${today}T12:00:00`));
  const rows = db.all<{ log_date: string; kcal: number; trained: number }>(
    `SELECT d.log_date, d.kcal,
            EXISTS (SELECT 1 FROM workout_session ws
                     WHERE date(ws.started_at) = d.log_date) AS trained
       FROM (SELECT log_date, SUM(total) AS kcal
               FROM v_daily_totals
              WHERE nutrient = 'kcal'
                AND log_date >= ? AND log_date <= ?
              GROUP BY log_date) d`,
    [from, today],
  );

  const on = rows.filter((r) => r.trained).map((r) => r.kcal);
  const off = rows.filter((r) => !r.trained).map((r) => r.kcal);
  const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const onKcal = mean(on);
  const offKcal = mean(off);

  return {
    onKcal, offKcal, nOn: on.length, nOff: off.length,
    differenceKcal: onKcal !== null && offKcal !== null ? round(onKcal - offKcal) : null,
    basis: `${on.length} training days and ${off.length} rest days in the last ${days}`,
  };
}

export interface WeekdayProfile {
  /** 0 = Sunday, matching SQLite's strftime('%w'). */
  weekday: number;
  label: string;
  meanKcal: number | null;
  meanSteps: number | null;
  nDays: number;
}

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday'];

/**
 * "What does my normal week look like?"
 *
 * Every row in this database is dated and none of them were ever
 * grouped by day of week, which is why weekday-versus-weekend was a
 * branch of the owner's model with nothing under it.
 */
export function weekProfile(db: Db, days = 56, today = localDate()): WeekdayProfile[] {
  const from = daysAgo(days, new Date(`${today}T12:00:00`));
  const kcal = db.all<{ w: string; mean_kcal: number; n: number }>(
    `SELECT strftime('%w', log_date) AS w, AVG(kcal) AS mean_kcal, COUNT(*) AS n
       FROM (SELECT log_date, SUM(total) AS kcal FROM v_daily_totals
              WHERE nutrient = 'kcal' AND log_date >= ? AND log_date <= ?
              GROUP BY log_date)
      GROUP BY w`, [from, today]);
  const steps = db.all<{ w: string; mean_steps: number }>(
    `SELECT strftime('%w', log_date) AS w, AVG(value) AS mean_steps
       FROM v_daily_metric
      WHERE metric = 'steps' AND log_date >= ? AND log_date <= ?
      GROUP BY w`, [from, today]);

  const kcalBy = new Map(kcal.map((r) => [Number(r.w), r]));
  const stepsBy = new Map(steps.map((r) => [Number(r.w), r.mean_steps]));

  return WEEKDAY_LABELS.map((label, weekday) => ({
    weekday,
    label,
    meanKcal: kcalBy.has(weekday) ? round(kcalBy.get(weekday)!.mean_kcal) : null,
    meanSteps: stepsBy.has(weekday) ? round(stepsBy.get(weekday)!) : null,
    nDays: kcalBy.get(weekday)?.n ?? 0,
  }));
}

// ------------------------------------------------------------------
// Revealed preference
// ------------------------------------------------------------------

export interface FoodHabit {
  foodId: number;
  name: string;
  nEntries: number;
  nDays: number;
  meanGrams: number | null;
  lastEatenAt: string;
}

/**
 * What you actually eat, ranked by how often.
 *
 * This is REVEALED preference, and calling it "what I enjoy" is a
 * stretch the data does not support - it also captures what is cheap,
 * to hand, and habitual. It is still the only honest signal available
 * without asking, and asking about every food is not something anyone
 * would complete.
 */
export function foodHabits(
  db: Db, days = 56, limit = 20, today = localDate(),
): FoodHabit[] {
  const from = daysAgo(days, new Date(`${today}T12:00:00`));
  return db.all<FoodHabit>(
    `SELECT le.food_id                       AS foodId,
            f.name                           AS name,
            COUNT(*)                         AS nEntries,
            COUNT(DISTINCT date(le.eaten_at)) AS nDays,
            ROUND(AVG(le.grams_resolved), 1) AS meanGrams,
            MAX(le.eaten_at)                 AS lastEatenAt
       FROM log_entry le
       JOIN food f ON f.id = le.food_id
      WHERE le.status = 'resolved'
        AND date(le.eaten_at) >= ? AND date(le.eaten_at) <= ?
      GROUP BY le.food_id, f.name
      ORDER BY nEntries DESC, nDays DESC
      LIMIT ?`,
    [from, today, limit],
  );
}

// ------------------------------------------------------------------
// Energy balance
// ------------------------------------------------------------------

export interface EnergyBalance {
  meanIntakeKcal: number | null;
  meanTargetKcal: number | null;
  nDays: number;
  /** Positive means eating above target. */
  gapKcal: number | null;
  /**
   * What the weight series says was actually happening, converted to
   * kcal/day at 7000 kcal/kg. Null without a trend.
   */
  impliedGapKcal: number | null;
  basis: string;
}

/** 7000 kcal per kg, the figure the goal screens are pinned to. */
const KCAL_PER_KG = 7000;

/**
 * Intake against target, and against what the scale says.
 *
 * The two can disagree, and when they do the disagreement is the most
 * useful number in the application: it is either the logging drifting
 * or the target being wrong, and `daily_logging_stats` is what tells
 * the two apart. This function does not guess which; it reports both.
 */
export function energyBalance(
  db: Db, days = 28, today = localDate(),
): EnergyBalance {
  const from = daysAgo(days, new Date(`${today}T12:00:00`));
  const intake = db.get<{ mean_kcal: number; n: number }>(
    `SELECT AVG(kcal) AS mean_kcal, COUNT(*) AS n
       FROM (SELECT log_date, SUM(total) AS kcal FROM v_daily_totals
              WHERE nutrient = 'kcal' AND log_date >= ? AND log_date <= ?
              GROUP BY log_date)`, [from, today]);
  const target = db.get<{ mean_kcal: number }>(
    `SELECT AVG(kcal) AS mean_kcal FROM v_energy_target
      WHERE log_date >= ? AND log_date <= ?`, [from, today]);

  const trend = weightTrend(db, days, today);
  const meanIntake = intake?.mean_kcal ?? null;
  const meanTarget = target?.mean_kcal ?? null;

  return {
    meanIntakeKcal: meanIntake === null ? null : round(meanIntake),
    meanTargetKcal: meanTarget === null ? null : round(meanTarget),
    nDays: intake?.n ?? 0,
    gapKcal: meanIntake !== null && meanTarget !== null
      ? round(meanIntake - meanTarget) : null,
    impliedGapKcal: trend === null
      ? null : round((trend.kgPerWeek * KCAL_PER_KG) / 7),
    basis: trend
      ? `${intake?.n ?? 0} logged days; scale says ${trend.kgPerWeek} kg/week over ${trend.basis}`
      : `${intake?.n ?? 0} logged days; not enough weight readings for a trend`,
  };
}
