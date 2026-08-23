import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from './helpers';
import type { Db } from '../src/core/db';
import {
  DEFAULT_MAX_SWING, baselines, clearPlan, dayInputs, planDays, planWeek,
  scoreDay, writePlan, type Baselines, type DayInputs,
} from '../src/core/cycling';
import { activeTarget, estimateTargets, macroBudget, rateForGoal, saveProfile,
  weightProgress, writeTargets, type BodyProfile } from '../src/core/energy';

let db: Db;
beforeEach(() => { db = freshDb(); });

const flat = (date: string, over: Partial<DayInputs> = {}): DayInputs => ({
  logDate: date, sessionKcal: 0, sleepMin: null, hrvMs: null,
  rhrBpm: null, stressAvg: null, ...over,
});

const NO_BASE: Baselines = { sleepMin: null, hrvMs: null, rhrBpm: null, stressAvg: null };
const BASE: Baselines = { sleepMin: 420, hrvMs: 60, rhrBpm: 50, stressAvg: 30 };

const scored = (days: DayInputs[], base = BASE) =>
  days.map((inputs) => ({ inputs, score: scoreDay(inputs, base) }));

// -----------------------------------------------------------------
// The property that makes cycling safe to ship.
// -----------------------------------------------------------------
describe('the weekly total is conserved', () => {
  it('spends exactly the flat weekly budget, however uneven the days', () => {
    const days = scored([
      flat('2026-08-17', { sessionKcal: 900, sleepMin: 300, hrvMs: 40 }),
      flat('2026-08-18'),
      flat('2026-08-19', { sessionKcal: 400 }),
      flat('2026-08-20', { sleepMin: 500, hrvMs: 75 }),
      flat('2026-08-21'),
      flat('2026-08-22', { sessionKcal: 1200 }),
      flat('2026-08-23'),
    ]);
    const { plan, weeklyTotal, flatTotal } = planDays(2000, days);
    expect(flatTotal).toBe(14000);
    // Cycling changes WHEN the calories fall, never how many. Rounding
    // to whole kcal is the only permitted drift.
    expect(Math.abs(weeklyTotal - flatTotal)).toBeLessThanOrEqual(plan.length);
  });

  it('produces a genuinely uneven week', () => {
    const days = scored([
      flat('2026-08-17', { sessionKcal: 1200 }),
      flat('2026-08-18'),
      flat('2026-08-19'),
      flat('2026-08-20'),
      flat('2026-08-21'),
      flat('2026-08-22'),
      flat('2026-08-23'),
    ]);
    const { plan } = planDays(2000, days);
    expect(plan[0].kcal).toBeGreaterThan(plan[1].kcal);
    expect(new Set(plan.map((d) => d.kcal)).size).toBeGreaterThan(1);
  });

  it('leaves a featureless week flat', () => {
    const days = scored(
      ['17', '18', '19', '20', '21', '22', '23'].map((d) => flat(`2026-08-${d}`)), NO_BASE);
    const { plan } = planDays(2000, days);
    for (const d of plan) expect(d.kcal).toBe(2000);
    for (const d of plan) expect(d.reasons).toEqual(['no signal either way']);
  });

  it('honours the swing cap', () => {
    const days = scored([
      flat('2026-08-17', { sessionKcal: 5000 }),
      ...['18', '19', '20', '21', '22', '23'].map((d) => flat(`2026-08-${d}`)),
    ]);
    const { plan } = planDays(2000, days, { maxSwing: 0.2 });
    for (const d of plan) {
      expect(d.kcal).toBeLessThanOrEqual(2000 * 1.2 + 1);
      expect(d.kcal).toBeGreaterThanOrEqual(2000 * 0.8 - 1);
    }
  });

  it('a swing of zero switches cycling off entirely', () => {
    const days = scored([
      flat('2026-08-17', { sessionKcal: 1500 }),
      ...['18', '19', '20', '21', '22', '23'].map((d) => flat(`2026-08-${d}`)),
    ]);
    const { plan } = planDays(2000, days, { maxSwing: 0 });
    for (const d of plan) expect(d.kcal).toBe(2000);
  });

  it('exposes the default swing as a documented constant', () => {
    expect(DEFAULT_MAX_SWING).toBe(0.2);
  });
});

// -----------------------------------------------------------------
// Direction of each signal, stated as a test so it cannot drift.
// -----------------------------------------------------------------
describe('what moves a day', () => {
  it('a training day gets more', () => {
    const { weight, reasons } = scoreDay(flat('d', { sessionKcal: 600 }), BASE);
    expect(weight).toBeGreaterThan(1);
    expect(reasons[0]).toContain('trained');
  });

  it('a short night eases the deficit', () => {
    // Short sleep raises appetite and impairs glucose handling; stacking
    // a deep deficit on top of it is the combination people quit on.
    const { weight } = scoreDay(flat('d', { sleepMin: 300 }), BASE);
    expect(weight).toBeGreaterThan(1);
  });

  it('suppressed HRV eases the deficit', () => {
    const { weight, reasons } = scoreDay(flat('d', { hrvMs: 40 }), BASE);
    expect(weight).toBeGreaterThan(1);
    expect(reasons.join(' ')).toContain('HRV');
  });

  it('a well-recovered day takes the deeper deficit', () => {
    const rested = scoreDay(flat('d', { sleepMin: 500, hrvMs: 75 }), BASE);
    expect(rested.weight).toBeLessThan(1);
  });

  it('a missing metric contributes nothing rather than defaulting to average', () => {
    // "The watch was on the charger" is not "an average night", and this
    // app does not invent measurements.
    expect(scoreDay(flat('d'), BASE).weight).toBe(1);
    expect(scoreDay(flat('d', { sleepMin: 300 }), NO_BASE).weight).toBe(1);
  });

  it('explains every day in words', () => {
    const { reasons } = scoreDay(flat('d', { sessionKcal: 700, hrvMs: 40 }), BASE);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    for (const r of reasons) expect(r).toMatch(/%/);
  });
});

// -----------------------------------------------------------------
// The safety floor.
// -----------------------------------------------------------------
describe('the floor is the one thing allowed to break the arithmetic', () => {
  it('never plans a day below the floor, and says it happened', () => {
    const days = scored([
      flat('2026-08-17', { sessionKcal: 4000 }),
      ...['18', '19'].map((d) => flat(`2026-08-${d}`)),
    ]);
    const { plan, floorApplied } = planDays(1400, days, { maxSwing: 0.5, sex: 'male' });
    expect(floorApplied).toBe(true);
    for (const d of plan) expect(d.kcal).toBeGreaterThanOrEqual(1500);
  });
});

// -----------------------------------------------------------------
// Reading the watch data back out.
// -----------------------------------------------------------------
describe('inputs come from the imported metrics', () => {
  const seed = () => {
    db.run(`INSERT INTO workout_session (started_at, kind) VALUES ('2026-08-22T07:00:00','run')`);
    db.run(`INSERT INTO session_energy VALUES (1,'garmin',700,'2026-08-22T08:00:00')`);
    for (const [m, v] of [['sleep_min', 380], ['hrv_ms', 45], ['stress_avg', 44]] as const) {
      db.run(`INSERT INTO daily_metric VALUES ('2026-08-22', ?, 'garmin', ?, '2026-08-22T09:00:00')`,
             [m, v]);
    }
    for (const d of ['2026-08-15', '2026-08-16', '2026-08-17']) {
      db.run(`INSERT INTO daily_metric VALUES (?, 'sleep_min', 'garmin', 430, '2026-08-17T09:00:00')`, [d]);
      db.run(`INSERT INTO daily_metric VALUES (?, 'hrv_ms', 'garmin', 62, '2026-08-17T09:00:00')`, [d]);
    }
  };

  it('reads session energy through the precedence view', () => {
    seed();
    db.run(`INSERT INTO session_energy VALUES (1,'met_estimate',500,'2026-08-22T08:00:00')`);
    // Two estimates stored, one summed - the same guarantee as everywhere else.
    expect(dayInputs(db, '2026-08-22').sessionKcal).toBe(700);
  });

  it('reads the body metrics for the day', () => {
    seed();
    const inputs = dayInputs(db, '2026-08-22');
    expect(inputs).toMatchObject({ sleepMin: 380, hrvMs: 45, stressAvg: 44 });
  });

  it('computes baselines from your own recent data, not a population norm', () => {
    seed();
    const base = baselines(db, '2026-08-22');
    expect(base.sleepMin).toBeCloseTo(430, 6);
    expect(base.hrvMs).toBeCloseTo(62, 6);
  });

  it('plans a real week end to end and stores it', () => {
    seed();
    const { plan, weeklyTotal, flatTotal } = planWeek(db, 2000, '2026-08-22', 7);
    expect(plan).toHaveLength(7);
    expect(Math.abs(weeklyTotal - flatTotal)).toBeLessThanOrEqual(7);

    expect(writePlan(db, plan)).toBe(7);
    const stored = db.all<{ kcal: number }>(
      "SELECT kcal FROM energy_target WHERE source = 'cycled' ORDER BY log_date");
    expect(stored).toHaveLength(7);
    expect(stored[0].kcal).toBe(plan[0].kcal);
  });
});

// -----------------------------------------------------------------
// Where a cycled day sits in the precedence order.
// -----------------------------------------------------------------
describe('precedence', () => {
  const MAN: BodyProfile = {
    sex: 'male', ageYears: 30, heightCm: 180, weightKg: 80,
    bodyFatPct: null, activityFactor: 1.465, goalRateKgPerWeek: -0.5,
  };

  it('a cycled day outranks the flat formula', () => {
    writeTargets(db, MAN, '2026-08-22');
    writePlan(db, [{ logDate: '2026-08-22', kcal: 2222, weight: 1.1, reasons: [], basis: 'x' }]);
    expect(activeTarget(db, '2026-08-22')).toMatchObject({ source: 'cycled', kcal: 2222 });
  });

  it('but a number you set by hand still wins', () => {
    writeTargets(db, MAN, '2026-08-22');
    writePlan(db, [{ logDate: '2026-08-22', kcal: 2222, weight: 1.1, reasons: [], basis: 'x' }]);
    db.run(`INSERT INTO energy_target VALUES ('2026-08-22','manual',1900,'by hand','2026-08-22T00:00:00')`);
    expect(activeTarget(db, '2026-08-22')!.source).toBe('manual');
  });

  it('clearing the plan from a day falls that day back to the formula', () => {
    writeTargets(db, MAN, '2026-08-22');
    writePlan(db, [{ logDate: '2026-08-22', kcal: 2222, weight: 1.1, reasons: [], basis: 'x' }]);
    clearPlan(db, '2026-08-22');
    expect(activeTarget(db, '2026-08-22')!.source).toBe('mifflin');
  });
});

// -----------------------------------------------------------------
// Macro budget, checked against the reference screenshot.
// -----------------------------------------------------------------
describe('macronutrient budget', () => {
  it('reproduces the balanced 20/50/30 split for a 2450 kcal budget', () => {
    // The owner's screenshot shows 2,450 Cal -> Protein 122 g, Carb 306 g,
    // Fats 81 g against a "Balanced" macro goal.
    const b = macroBudget(2450, { proteinPct: 20, carbPct: 50, fatPct: 30 });
    expect(b.proteinG).toBe(123);   // 2450*0.20/4 = 122.5
    expect(b.carbG).toBe(306);
    expect(b.fatG).toBe(82);        // 2450*0.30/9 = 81.7
  });

  it('scales fibre with intake rather than fixing it', () => {
    expect(macroBudget(2000, { proteinPct: 20, carbPct: 50, fatPct: 30 }, 14).fibreG).toBe(28);
    expect(macroBudget(3000, { proteinPct: 20, carbPct: 50, fatPct: 30 }, 14).fibreG).toBe(42);
  });

  it('reports a split that does not sum to 100 rather than repairing it', () => {
    // A split adding to 95 is a mistake worth seeing.
    const b = macroBudget(2000, { proteinPct: 20, carbPct: 45, fatPct: 30 });
    expect(b.splitSumsTo).toBe(95);
  });
});

// -----------------------------------------------------------------
// Weight goal.
// -----------------------------------------------------------------
describe('weight goal', () => {
  const P: BodyProfile = {
    sex: 'male', ageYears: 30, heightCm: 180, weightKg: 101,
    bodyFatPct: null, activityFactor: 1.725, goalRateKgPerWeek: -1, goalWeightKg: 83,
  };

  it('tracks start, current and remaining from the profile history', () => {
    saveProfile(db, P);
    saveProfile(db, { ...P, weightKg: 97.5 });
    const w = weightProgress(db)!;
    expect(w).toMatchObject({ startKg: 101, currentKg: 97.5, goalKg: 83, lostKg: 3.5 });
    expect(w.remainingKg).toBeCloseTo(14.5, 6);
  });

  it('estimates weeks to the goal at the chosen rate', () => {
    saveProfile(db, P);
    expect(weightProgress(db)!.weeksToGoal).toBeCloseTo(18, 6);
  });

  it('flags a rate that points away from the goal instead of predicting nonsense', () => {
    saveProfile(db, { ...P, goalRateKgPerWeek: 0.5 });
    const w = weightProgress(db)!;
    expect(w.rateContradictsGoal).toBe(true);
    expect(w.weeksToGoal).toBeNull();
  });

  it('derives the rate needed to arrive by a deadline', () => {
    expect(rateForGoal(101, 83, 18)).toBe(-1);
  });

  it('returns null before any profile exists', () => {
    expect(weightProgress(db)).toBeNull();
  });
});

// -----------------------------------------------------------------
// Hardening pass regressions.
// -----------------------------------------------------------------
describe('cancelling a plan does not rewrite history', () => {
  it('keeps past cycled days and removes only today forward', () => {
    for (const d of ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23']) {
      writePlan(db, [{ logDate: d, kcal: 2100, weight: 1, reasons: [], basis: 'x' }]);
    }
    clearPlan(db, '2026-08-22');
    const left = db.all<{ log_date: string }>(
      "SELECT log_date FROM energy_target WHERE source = 'cycled' ORDER BY log_date");
    // What the target WAS on a logged day is part of that day's record.
    expect(left.map((r) => r.log_date)).toEqual(['2026-08-20', '2026-08-21']);
  });
});

describe('the profile boundary rejects poisoned numbers', () => {
  const P: BodyProfile = {
    sex: 'male', ageYears: 30, heightCm: 180, weightKg: 80,
    bodyFatPct: null, activityFactor: 1.465, goalRateKgPerWeek: -0.5,
  };

  it('throws on NaN rather than silently corrupting every future target', () => {
    expect(() => saveProfile(db, { ...P, weightKg: NaN })).toThrow(/weight/);
    expect(() => saveProfile(db, { ...P, ageYears: Infinity })).toThrow(/age/);
    expect(() => saveProfile(db, { ...P, bodyFatPct: NaN })).toThrow(/body fat/);
    expect(db.all('SELECT * FROM body_profile')).toHaveLength(0);
  });

  it('rejects a non-positive body', () => {
    expect(() => saveProfile(db, { ...P, weightKg: 0 })).toThrow(/positive/);
    expect(() => saveProfile(db, { ...P, heightCm: -170 })).toThrow(/positive/);
  });

  it('does not police ranges - the user\'s number is the number', () => {
    expect(() => saveProfile(db, { ...P, ageYears: 200 })).not.toThrow();
  });
});

describe('degenerate formulas emit nothing instead of nonsense', () => {
  it('skips a formula whose BMR goes non-positive', () => {
    // The regressions go negative far outside the fitted population.
    // "Not applicable" beats a negative calorie target with an Infinity
    // percent attached.
    const est = estimateTargets({
      sex: 'female', ageYears: 200, heightCm: 90, weightKg: 26,
      bodyFatPct: null, activityFactor: 1.2, goalRateKgPerWeek: 0,
    });
    for (const e of est) {
      expect(e.target).toBeGreaterThan(0);
      expect(Number.isFinite(e.percentOfMaintenance)).toBe(true);
    }
  });
});
