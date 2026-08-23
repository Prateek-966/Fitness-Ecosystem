import type { Db } from './db';
import { localIso, localDate } from './clock';

/**
 * Goal setting: BMR, TDEE and a daily energy target.
 *
 * Modelled on calculator.net's calorie calculator, which the owner asked
 * for. The equations below are the canonical published forms; the
 * activity factors and goal rates are the conventional set. Both are
 * stored as DATA rather than compiled in - activity_factor is a plain
 * number on body_profile, so any preset can be overridden with a figure
 * that matches whatever source you trust.
 *
 * WHAT THESE NUMBERS ARE. A population regression, evaluated on one
 * person. Mifflin-St Jeor was fitted on 498 people and predicts an
 * individual's resting expenditure to roughly +/-10% at one standard
 * deviation; the three formulas here routinely disagree by a couple of
 * hundred kcal on the same body. So each is stored in its own
 * energy_target row and none is averaged with another - the disagreement
 * is information, and a mean of three estimates is not more accurate than
 * the best of them, merely more confident-looking.
 *
 * This is the same principle the whole app runs on: a target is a
 * reference line drawn from a formula, not a measurement of you. The
 * eventual adaptive model - which regresses YOUR logged intake against
 * YOUR measured weight change - slots in as one more source and outranks
 * all three, because it is the only one fitted to the person using it.
 */

export type Sex = 'male' | 'female';
export type Formula = 'mifflin' | 'harris' | 'katch';
export type TargetSource = 'manual' | 'cycled' | 'adaptive' | Formula;

export interface BodyProfile {
  sex: Sex;
  ageYears: number;
  heightCm: number;
  weightKg: number;
  /** Only supply if actually measured. Katch-McArdle is skipped without it. */
  bodyFatPct?: number | null;
  activityFactor: number;
  /** Negative loses, positive gains, zero maintains. */
  goalRateKgPerWeek: number;
  /** Where you are heading. Null means a rate with no destination. */
  goalWeightKg?: number | null;
}

/**
 * Conventional activity multipliers. Presets for the UI, not a
 * constraint: the chosen value is stored as a number, so any figure can
 * be entered.
 */
export const ACTIVITY_LEVELS = [
  { key: 'sedentary', label: 'Sedentary: little or no exercise', factor: 1.2 },
  { key: 'light', label: 'Light: exercise 1-3 times/week', factor: 1.375 },
  { key: 'moderate', label: 'Moderate: exercise 4-5 times/week', factor: 1.465 },
  { key: 'active', label: 'Active: daily exercise, or intense 3-4 times/week', factor: 1.55 },
  { key: 'very_active', label: 'Very active: intense exercise 6-7 times/week', factor: 1.725 },
  { key: 'extra_active', label: 'Extra active: very intense daily, or a physical job', factor: 1.9 },
] as const;

/**
 * Energy density of body mass, kcal per kg.
 *
 * 7000 rather than the physiological ~7700 for adipose tissue, because
 * that is what reproduces calculator.net's published figures exactly:
 * 0.25 kg/week maps to 250 kcal/day, 0.5 to 500, 1.0 to 1000. It comes
 * from the US convention of 500 kcal/day per pound per week, carried
 * across to kilograms and rounded.
 *
 * Either way it is a rule of thumb, not a constant: real weight change is
 * part fat, part lean, part water, and the ratio shifts with the size of
 * the deficit. Good enough to set a starting line; not good enough to
 * explain a plateau.
 */
export const KCAL_PER_KG = 7000;

export const GOAL_RATES = [
  { key: 'lose_fast', label: 'Extreme weight loss: 1 kg/week', rate: -1 },
  { key: 'lose', label: 'Weight loss: 0.5 kg/week', rate: -0.5 },
  { key: 'lose_slow', label: 'Mild weight loss: 0.25 kg/week', rate: -0.25 },
  { key: 'maintain', label: 'Maintain weight', rate: 0 },
  { key: 'gain_slow', label: 'Mild weight gain: 0.25 kg/week', rate: 0.25 },
  { key: 'gain', label: 'Weight gain: 0.5 kg/week', rate: 0.5 },
  { key: 'gain_fast', label: 'Fast weight gain: 1 kg/week', rate: 1 },
] as const;

/**
 * Floors below which sustained intake is generally considered unsafe
 * without medical supervision. These WARN; they never clamp. The brief's
 * eighth principle is explicit: explain the consequence once, then do
 * exactly what was asked.
 */
export const SAFE_FLOOR_KCAL: Record<Sex, number> = { male: 1500, female: 1200 };

// ------------------------------------------------------------------
// Basal metabolic rate
// ------------------------------------------------------------------

/** Mifflin-St Jeor (1990). The usual default, and the best validated. */
export function bmrMifflin(p: BodyProfile): number {
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.ageYears;
  return p.sex === 'male' ? base + 5 : base - 161;
}

/** Revised Harris-Benedict (Roza & Shizgal, 1984). */
export function bmrHarris(p: BodyProfile): number {
  return p.sex === 'male'
    ? 13.397 * p.weightKg + 4.799 * p.heightCm - 5.677 * p.ageYears + 88.362
    : 9.247 * p.weightKg + 3.098 * p.heightCm - 4.330 * p.ageYears + 447.593;
}

/**
 * Katch-McArdle. Uses lean mass, so it needs a real body-fat figure and
 * returns null without one - guessing body fat to feed a formula whose
 * whole advantage is measured lean mass would be theatre.
 */
export function bmrKatch(p: BodyProfile): number | null {
  if (p.bodyFatPct === null || p.bodyFatPct === undefined) return null;
  if (p.bodyFatPct < 0 || p.bodyFatPct >= 100) return null;
  const leanKg = p.weightKg * (1 - p.bodyFatPct / 100);
  return 370 + 21.6 * leanKg;
}

export function bmr(p: BodyProfile, formula: Formula): number | null {
  if (formula === 'mifflin') return bmrMifflin(p);
  if (formula === 'harris') return bmrHarris(p);
  return bmrKatch(p);
}

/** Maintenance requirement: BMR scaled by how much you move. */
export const tdee = (basal: number, activityFactor: number): number =>
  basal * activityFactor;

/** kcal/day to add or remove to move weight at the requested rate. */
export const goalDelta = (rateKgPerWeek: number): number =>
  (rateKgPerWeek * KCAL_PER_KG) / 7;

export interface TargetEstimate {
  source: Formula;
  bmr: number;
  maintenance: number;
  target: number;
  /** Target as a percentage of maintenance, as calculator.net reports it. */
  percentOfMaintenance: number;
  basis: string;
}

/** Every formula that can run, each kept separate. None are averaged. */
export function estimateTargets(p: BodyProfile): TargetEstimate[] {
  const delta = goalDelta(p.goalRateKgPerWeek);
  const out: TargetEstimate[] = [];

  for (const source of ['mifflin', 'harris', 'katch'] as const) {
    const basal = bmr(p, source);
    if (basal === null) continue;          // Katch without a body-fat figure
    const maintenance = tdee(basal, p.activityFactor);
    const target = round(maintenance + delta);
    out.push({
      source,
      bmr: round(basal),
      maintenance: round(maintenance),
      target,
      percentOfMaintenance: Math.round((target / maintenance) * 100),
      basis:
        `${source} BMR ${round(basal)} x activity ${p.activityFactor}`
        + ` = ${round(maintenance)} maintenance`
        + (delta === 0 ? '' : `, ${delta > 0 ? '+' : ''}${round(delta)} for `
          + `${p.goalRateKgPerWeek > 0 ? '+' : ''}${p.goalRateKgPerWeek} kg/week`),
    });
  }
  return out;
}

const round = (n: number) => Math.round(n);

export interface SafetyNote {
  belowFloor: boolean;
  floor: number;
  message: string | null;
}

/** Surfaces the consequence. Does not block, and never adjusts the number. */
export function safetyCheck(p: BodyProfile, target: number): SafetyNote {
  const floor = SAFE_FLOOR_KCAL[p.sex];
  if (target >= floor) return { belowFloor: false, floor, message: null };
  return {
    belowFloor: true,
    floor,
    message:
      `${round(target)} kcal is below the ${floor} generally considered a floor for sustained `
      + 'intake without medical supervision. The target is set as asked; this is the one '
      + 'mention it gets.',
  };
}

// ------------------------------------------------------------------
// Persistence
// ------------------------------------------------------------------

export function saveProfile(db: Db, p: BodyProfile): number {
  // Append-only: weight moves, and recomputing today's target must not
  // silently rewrite what last month's target was.
  return db.run(
    `INSERT INTO body_profile
       (recorded_at, sex, age_years, height_cm, weight_kg, body_fat_pct,
        activity_factor, goal_rate_kg_per_week, goal_weight_kg)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [localIso(), p.sex, p.ageYears, p.heightCm, p.weightKg,
     p.bodyFatPct ?? null, p.activityFactor, p.goalRateKgPerWeek,
     p.goalWeightKg ?? null],
  ).lastInsertRowid;
}

export function currentProfile(db: Db): BodyProfile | null {
  const row = db.get<any>(
    `SELECT sex, age_years, height_cm, weight_kg, body_fat_pct,
            activity_factor, goal_rate_kg_per_week, goal_weight_kg
     FROM body_profile ORDER BY recorded_at DESC, id DESC LIMIT 1`,
  );
  if (!row) return null;
  return {
    sex: row.sex,
    ageYears: row.age_years,
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    bodyFatPct: row.body_fat_pct,
    activityFactor: row.activity_factor,
    goalRateKgPerWeek: row.goal_rate_kg_per_week,
    goalWeightKg: row.goal_weight_kg,
  };
}

/** Writes one row per formula. Idempotent for a given day. */
export function writeTargets(db: Db, p: BodyProfile, date = localDate()): TargetEstimate[] {
  const estimates = estimateTargets(p);
  const now = localIso();
  db.tx(() => {
    for (const e of estimates) {
      db.run(
        `INSERT INTO energy_target (log_date, source, kcal, basis, computed_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(log_date, source) DO UPDATE SET
           kcal = excluded.kcal, basis = excluded.basis, computed_at = excluded.computed_at`,
        [date, e.source, e.target, e.basis, now],
      );
    }
  });
  return estimates;
}

/** An explicit number always outranks a formula. You said so. */
export function setManualTarget(db: Db, kcal: number, date = localDate()): void {
  db.run(
    `INSERT INTO energy_target (log_date, source, kcal, basis, computed_at)
     VALUES (?, 'manual', ?, 'set by hand', ?)
     ON CONFLICT(log_date, source) DO UPDATE SET
       kcal = excluded.kcal, computed_at = excluded.computed_at`,
    [date, kcal, localIso()],
  );
}

export function clearManualTarget(db: Db, date = localDate()): void {
  db.run("DELETE FROM energy_target WHERE log_date = ? AND source = 'manual'", [date]);
}

export interface ActiveTarget {
  kcal: number;
  source: TargetSource;
  basis: string | null;
}

/** The one target in force today, chosen by v_energy_target's precedence. */
export function activeTarget(db: Db, date = localDate()): ActiveTarget | null {
  const row = db.get<{ kcal: number; source: TargetSource; basis: string | null }>(
    'SELECT kcal, source, basis FROM v_energy_target WHERE log_date = ?', [date],
  );
  return row ?? null;
}

/** Every estimate for a day, so the spread between formulas stays visible. */
export function allTargets(db: Db, date = localDate()) {
  return db.all<{ source: TargetSource; kcal: number; basis: string | null }>(
    'SELECT source, kcal, basis FROM energy_target WHERE log_date = ? ORDER BY kcal', [date],
  );
}

// ------------------------------------------------------------------
// Splitting the day across meals
// ------------------------------------------------------------------

export interface MealTarget {
  slot: string;
  kcal: number;
  /** true when the share came from your own history rather than an even split. */
  fromHistory: boolean;
}

/**
 * Distribute a daily target across the derived meal windows.
 *
 * Weighted by how you have ACTUALLY eaten in each slot, because a fixed
 * 25/12.5/25/12.5/25 split is another decision made on your behalf - and
 * this app already knows better, having clustered your own timestamps to
 * find the slots in the first place. Falls back to an even split until
 * there is enough history to weight with.
 */
export function mealTargets(db: Db, dailyTarget: number, minEntries = 12): MealTarget[] {
  const slots = db.all<{ slot: string }>(
    'SELECT slot FROM meal_slot_window ORDER BY centre_min',
  ).map((r) => r.slot);
  if (slots.length === 0) return [];

  const history = db.all<{ meal_slot: string; kcal: number }>(
    `SELECT le.meal_slot, SUM(le.grams_resolved / 100.0 * fn.per_100g) AS kcal
     FROM log_entry le
     JOIN food_nutrient fn ON fn.food_id = le.food_id AND fn.nutrient = 'kcal'
     WHERE le.status = 'resolved' AND le.meal_slot IS NOT NULL
     GROUP BY le.meal_slot`,
  );

  const total = history.reduce((s, r) => s + (r.kcal ?? 0), 0);
  const counted = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM log_entry WHERE status = 'resolved' AND meal_slot IS NOT NULL",
  )!.n;

  const enough = counted >= minEntries && total > 0
    && slots.every((s) => history.some((h) => h.meal_slot === s && h.kcal > 0));

  if (!enough) {
    const even = dailyTarget / slots.length;
    return slots.map((slot) => ({ slot, kcal: Math.round(even), fromHistory: false }));
  }

  return slots.map((slot) => {
    const share = (history.find((h) => h.meal_slot === slot)?.kcal ?? 0) / total;
    return { slot, kcal: Math.round(dailyTarget * share), fromHistory: true };
  });
}

// ------------------------------------------------------------------
// Macronutrient budget
// ------------------------------------------------------------------

/** Atwater factors: kcal per gram. */
export const KCAL_PER_G = { protein: 4, carb: 4, fat: 9 } as const;

export interface MacroSplit { proteinPct: number; carbPct: number; fatPct: number }

/**
 * Named splits. "Balanced" is the 20/50/30 that commercial trackers ship
 * as their default - a convention rather than a finding, which is why it
 * is a preset over editable settings rather than a constant in here.
 */
export const MACRO_PRESETS = [
  { key: 'balanced', label: 'Balanced — 20 / 50 / 30', proteinPct: 20, carbPct: 50, fatPct: 30 },
  { key: 'high_protein', label: 'Higher protein — 30 / 40 / 30', proteinPct: 30, carbPct: 40, fatPct: 30 },
  { key: 'lower_carb', label: 'Lower carb — 30 / 20 / 50', proteinPct: 30, carbPct: 20, fatPct: 50 },
] as const;

export interface MacroBudget {
  proteinG: number;
  carbG: number;
  fatG: number;
  fibreG: number;
  /** True when the percentages do not add to 100 and were used as given. */
  splitSumsTo: number;
}

/**
 * Grams of each macronutrient for a daily target.
 *
 * The percentages are used exactly as supplied even if they do not sum to
 * 100 - the sum is reported instead of silently normalised, because a
 * split that adds to 95 is a mistake worth seeing rather than a number to
 * quietly repair.
 */
export function macroBudget(
  kcal: number, split: MacroSplit, fibrePer1000 = 14,
): MacroBudget {
  return {
    proteinG: Math.round((kcal * split.proteinPct / 100) / KCAL_PER_G.protein),
    carbG: Math.round((kcal * split.carbPct / 100) / KCAL_PER_G.carb),
    fatG: Math.round((kcal * split.fatPct / 100) / KCAL_PER_G.fat),
    fibreG: Math.round((kcal / 1000) * fibrePer1000),
    splitSumsTo: split.proteinPct + split.carbPct + split.fatPct,
  };
}

// ------------------------------------------------------------------
// Weight goal
// ------------------------------------------------------------------

export interface WeightProgress {
  startKg: number;
  currentKg: number;
  goalKg: number | null;
  lostKg: number;
  remainingKg: number | null;
  /** Weeks to the goal at the chosen rate. Null if not heading anywhere. */
  weeksToGoal: number | null;
  /** True when the goal lies the opposite way from the chosen rate. */
  rateContradictsGoal: boolean;
}

/**
 * Progress from the append-only profile history: the earliest recorded
 * weight is the start, the latest is current. No separate "start weight"
 * field, because one would have to be kept in step with the history and
 * would eventually disagree with it.
 */
export function weightProgress(db: Db): WeightProgress | null {
  const first = db.get<{ weight_kg: number }>(
    'SELECT weight_kg FROM body_profile ORDER BY recorded_at ASC, id ASC LIMIT 1');
  const last = db.get<{ weight_kg: number; goal_weight_kg: number | null; goal_rate_kg_per_week: number }>(
    `SELECT weight_kg, goal_weight_kg, goal_rate_kg_per_week
     FROM body_profile ORDER BY recorded_at DESC, id DESC LIMIT 1`);
  if (!first || !last) return null;

  const goalKg = last.goal_weight_kg;
  const remaining = goalKg === null ? null : goalKg - last.weight_kg;
  const rate = last.goal_rate_kg_per_week;

  let weeks: number | null = null;
  let contradicts = false;
  if (remaining !== null && rate !== 0) {
    if (Math.sign(remaining) === Math.sign(rate)) weeks = Math.abs(remaining / rate);
    else contradicts = Math.abs(remaining) > 0.05;
  }

  return {
    startKg: first.weight_kg,
    currentKg: last.weight_kg,
    goalKg,
    lostKg: Number((first.weight_kg - last.weight_kg).toFixed(2)),
    remainingKg: remaining === null ? null : Number(Math.abs(remaining).toFixed(2)),
    weeksToGoal: weeks === null ? null : Number(weeks.toFixed(1)),
    rateContradictsGoal: contradicts,
  };
}

/** Rate implied by wanting to arrive at a goal weight in a given number of weeks. */
export const rateForGoal = (currentKg: number, goalKg: number, weeks: number): number =>
  weeks <= 0 ? 0 : Number(((goalKg - currentKg) / weeks).toFixed(3));
