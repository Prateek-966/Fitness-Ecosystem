import type { Db } from './db';
import { localDate, localIso } from './clock';
import { SAFE_FLOOR_KCAL, type Sex } from './energy';

/**
 * Spreading the week's calories unevenly across its days.
 *
 * The daily target from a BMR formula is a flat line. Real weeks are not
 * flat: a long run on Saturday and a desk-bound Tuesday do not need the
 * same intake, and a week of poor sleep is a bad week to deepen a
 * deficit. This allocates the SAME weekly total across seven days,
 * shifted by what the watch actually recorded.
 *
 * TWO PROPERTIES THAT ARE NOT NEGOTIABLE.
 *
 * 1. The weekly total is conserved exactly. Cycling changes WHEN the
 *    calories fall, never HOW MANY. The goal you set is the goal you get;
 *    if this could quietly hand back 200 kcal a day it would be a
 *    different goal wearing the same label.
 *
 * 2. Every number is explainable. This is a transparent weighted sum with
 *    published weights and a per-day sentence saying which input moved
 *    it, not a model whose output you have to take on faith. An app whose
 *    entire thesis is "the number should be honest about where it came
 *    from" cannot then produce its most consequential number from a black
 *    box. It also means a suggestion you disagree with can be argued
 *    with, which a black box cannot offer.
 *
 * WHAT THE EVIDENCE SUPPORTS. That training days need more fuel is
 * uncontroversial. That HRV, sleep and stress should modulate intake is
 * plausible and widely practised by coaches, but it is NOT established
 * that doing so improves body-composition outcomes over a flat deficit.
 * The weights below are therefore deliberately gentle and capped: this
 * nudges, it does not prescribe. Set max_cycle_swing to 0 to switch it
 * off entirely and keep the flat line.
 */

export interface DayInputs {
  logDate: string;
  /** kcal from v_session_energy, one row per session by precedence. */
  sessionKcal: number;
  sleepMin: number | null;
  hrvMs: number | null;
  rhrBpm: number | null;
  stressAvg: number | null;
}

export interface DayPlan {
  logDate: string;
  kcal: number;
  /** Multiplier applied before normalisation. 1.0 is a flat day. */
  weight: number;
  reasons: string[];
  basis: string;
}

/**
 * How far a single day may move from the flat target, as a fraction.
 * 0.20 means no day is more than 20% above or below the flat line.
 */
export const DEFAULT_MAX_SWING = 0.2;

/**
 * Weights, each the maximum fractional nudge that input can contribute.
 * Training is the largest because it is the only one measuring energy
 * actually spent; the recovery signals are correlates, not measurements,
 * and are weighted like correlates.
 */
export const WEIGHTS = {
  /** Per 500 kcal of recorded session energy. */
  training: 0.12,
  sleep: 0.05,
  hrv: 0.05,
  stress: 0.03,
} as const;

/** Rolling personal baselines. Population norms would mean nothing here. */
export interface Baselines {
  sleepMin: number | null;
  hrvMs: number | null;
  rhrBpm: number | null;
  stressAvg: number | null;
}

export function baselines(db: Db, before: string, days = 28): Baselines {
  const row = db.get<any>(
    `SELECT
       AVG(CASE WHEN metric = 'sleep_min'  THEN value END) AS sleep_min,
       AVG(CASE WHEN metric = 'hrv_ms'     THEN value END) AS hrv_ms,
       AVG(CASE WHEN metric = 'rhr_bpm'    THEN value END) AS rhr_bpm,
       AVG(CASE WHEN metric = 'stress_avg' THEN value END) AS stress_avg
     FROM v_daily_metric
     WHERE log_date < ? AND log_date >= date(?, ?)`,
    [before, before, `-${days} days`],
  );
  return {
    sleepMin: row?.sleep_min ?? null,
    hrvMs: row?.hrv_ms ?? null,
    rhrBpm: row?.rhr_bpm ?? null,
    stressAvg: row?.stress_avg ?? null,
  };
}

export function dayInputs(db: Db, date: string): DayInputs {
  const energy = db.get<{ kcal: number | null }>(
    `SELECT SUM(kcal) AS kcal FROM v_session_energy WHERE date(started_at) = ?`, [date],
  );
  const m = db.get<any>(
    `SELECT
       MAX(CASE WHEN metric = 'sleep_min'  THEN value END) AS sleep_min,
       MAX(CASE WHEN metric = 'hrv_ms'     THEN value END) AS hrv_ms,
       MAX(CASE WHEN metric = 'rhr_bpm'    THEN value END) AS rhr_bpm,
       MAX(CASE WHEN metric = 'stress_avg' THEN value END) AS stress_avg
     FROM v_daily_metric WHERE log_date = ?`,
    [date],
  );
  return {
    logDate: date,
    sessionKcal: energy?.kcal ?? 0,
    sleepMin: m?.sleep_min ?? null,
    hrvMs: m?.hrv_ms ?? null,
    rhrBpm: m?.rhr_bpm ?? null,
    stressAvg: m?.stress_avg ?? null,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Score one day. Returns a multiplier around 1.0 and the reasons for it.
 *
 * Direction of each signal, stated plainly because it is a judgement:
 *  - training up   -> eat more. Energy was spent.
 *  - sleep short   -> ease the deficit. Short sleep raises appetite and
 *                     impairs glucose handling; stacking a deep deficit
 *                     on top of it is the combination people quit on.
 *  - HRV down / RHR up -> ease the deficit. Both point at incomplete
 *                     recovery, and a deficit is itself a stressor.
 *  - stress up     -> ease the deficit, gently. Weakest signal, smallest weight.
 *
 * A missing metric contributes NOTHING. It does not default to average,
 * because "the watch was on the charger" is not the same as "an average
 * night", and this app does not invent measurements.
 */
export function scoreDay(day: DayInputs, base: Baselines): { weight: number; reasons: string[] } {
  let weight = 1;
  const reasons: string[] = [];

  if (day.sessionKcal > 0) {
    const bump = clamp((day.sessionKcal / 500) * WEIGHTS.training, 0, WEIGHTS.training * 2);
    weight += bump;
    reasons.push(`${Math.round(day.sessionKcal)} kcal trained (+${pct(bump)})`);
  }

  if (day.sleepMin !== null && base.sleepMin !== null && base.sleepMin > 0) {
    const shortfall = (base.sleepMin - day.sleepMin) / base.sleepMin;
    if (Math.abs(shortfall) > 0.05) {
      const bump = clamp(shortfall * WEIGHTS.sleep * 4, -WEIGHTS.sleep, WEIGHTS.sleep);
      weight += bump;
      reasons.push(shortfall > 0
        ? `slept ${Math.round(day.sleepMin)} min vs ${Math.round(base.sleepMin)} usual (+${pct(bump)})`
        : `slept well (${pct(bump)})`);
    }
  }

  if (day.hrvMs !== null && base.hrvMs !== null && base.hrvMs > 0) {
    const drop = (base.hrvMs - day.hrvMs) / base.hrvMs;
    if (Math.abs(drop) > 0.05) {
      const bump = clamp(drop * WEIGHTS.hrv * 4, -WEIGHTS.hrv, WEIGHTS.hrv);
      weight += bump;
      reasons.push(drop > 0
        ? `HRV ${Math.round(day.hrvMs)} below your ${Math.round(base.hrvMs)} (+${pct(bump)})`
        : `HRV above baseline (${pct(bump)})`);
    }
  }

  if (day.stressAvg !== null && base.stressAvg !== null && base.stressAvg > 0) {
    const rise = (day.stressAvg - base.stressAvg) / base.stressAvg;
    if (Math.abs(rise) > 0.1) {
      const bump = clamp(rise * WEIGHTS.stress * 3, -WEIGHTS.stress, WEIGHTS.stress);
      weight += bump;
      if (rise > 0) reasons.push(`stress above baseline (+${pct(bump)})`);
    }
  }

  if (reasons.length === 0) reasons.push('no signal either way');
  return { weight, reasons };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export interface PlanOptions {
  maxSwing?: number;
  /** Never plan a day below this. Warns rather than silently shrinking the week. */
  floorKcal?: number;
  sex?: Sex;
}

/**
 * Allocate `dailyTarget * dates.length` across the given days.
 *
 * Normalises the weights so the total is conserved exactly, then clamps
 * each day to +/- maxSwing and re-distributes the remainder among the
 * unclamped days. The floor is applied last and is the ONE case where the
 * weekly total may rise - a plan that starves a day to keep an arithmetic
 * identity would be the wrong trade, and the caller is told it happened.
 */
export function planDays(
  dailyTarget: number,
  days: Array<{ inputs: DayInputs; score: { weight: number; reasons: string[] } }>,
  opts: PlanOptions = {},
): { plan: DayPlan[]; weeklyTotal: number; flatTotal: number; floorApplied: boolean } {
  const maxSwing = opts.maxSwing ?? DEFAULT_MAX_SWING;
  const floor = opts.floorKcal ?? (opts.sex ? SAFE_FLOOR_KCAL[opts.sex] : 0);
  const flatTotal = dailyTarget * days.length;

  if (days.length === 0) return { plan: [], weeklyTotal: 0, flatTotal: 0, floorApplied: false };

  const lo = dailyTarget * (1 - maxSwing);
  const hi = dailyTarget * (1 + maxSwing);

  const sumWeights = days.reduce((s, d) => s + d.score.weight, 0);
  let raw = days.map((d) => (d.score.weight / sumWeights) * flatTotal);

  // Clamp, then push the remainder onto whichever days still have room,
  // repeating until it settles. Converges quickly - at most one pass per
  // day - and preserves the total.
  for (let pass = 0; pass < days.length; pass++) {
    const clamped = raw.map((v) => clamp(v, lo, hi));
    const deficit = flatTotal - clamped.reduce((s, v) => s + v, 0);
    if (Math.abs(deficit) < 0.5) { raw = clamped; break; }

    const room = clamped.map((v) => (deficit > 0 ? hi - v : v - lo));
    const totalRoom = room.reduce((s, v) => s + v, 0);
    if (totalRoom < 0.5) { raw = clamped; break; }
    raw = clamped.map((v, i) => v + (deficit * room[i]) / totalRoom);
  }

  let floorApplied = false;
  const plan: DayPlan[] = days.map((d, i) => {
    let kcal = Math.round(raw[i]);
    if (floor > 0 && kcal < floor) { kcal = floor; floorApplied = true; }
    return {
      logDate: d.inputs.logDate,
      kcal,
      weight: Number(d.score.weight.toFixed(4)),
      reasons: d.score.reasons,
      basis: `cycled from ${Math.round(dailyTarget)} flat: ${d.score.reasons.join('; ')}`,
    };
  });

  return {
    plan,
    weeklyTotal: plan.reduce((s, d) => s + d.kcal, 0),
    flatTotal,
    floorApplied,
  };
}

/** Convenience: read the inputs for a run of dates and plan them. */
export function planWeek(
  db: Db, dailyTarget: number, startDate = localDate(), length = 7, opts: PlanOptions = {},
) {
  const dates = Array.from({ length }, (_, i) => {
    const d = new Date(`${startDate}T00:00:00`);
    d.setDate(d.getDate() + i);
    return localDate(d);
  });
  const base = baselines(db, startDate);
  const days = dates.map((date) => {
    const inputs = dayInputs(db, date);
    return { inputs, score: scoreDay(inputs, base) };
  });
  return { ...planDays(dailyTarget, days, opts), baselines: base };
}

/** Persist a plan as energy_target rows with source 'cycled'. */
export function writePlan(db: Db, plan: DayPlan[]): number {
  const now = localIso();
  db.tx(() => {
    for (const d of plan) {
      db.run(
        `INSERT INTO energy_target (log_date, source, kcal, basis, computed_at)
         VALUES (?, 'cycled', ?, ?, ?)
         ON CONFLICT(log_date, source) DO UPDATE SET
           kcal = excluded.kcal, basis = excluded.basis, computed_at = excluded.computed_at`,
        [d.logDate, d.kcal, d.basis, now],
      );
    }
  });
  return plan.length;
}

/**
 * Cancel the plan from a given day forward. Past days are kept: what the
 * target WAS on a day you already logged is part of that day's record,
 * and the eventual adaptive model reads intake against the target then in
 * force. Cancelling a plan is a decision about the future, not an erasure
 * of the past.
 */
export function clearPlan(db: Db, fromDate = localDate()): void {
  db.run("DELETE FROM energy_target WHERE source = 'cycled' AND log_date >= ?", [fromDate]);
}
