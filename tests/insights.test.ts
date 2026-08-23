import { beforeEach, describe, expect, it } from 'vitest';
import { addFood, freshDb, unitId } from './helpers';
import type { Db } from '../src/core/db';
import {
  energyBalance, foodHabits, nutrientHabits, trainingDayIntake,
  weekProfile, weightTrend,
} from '../src/core/insights';
import { weightProgress } from '../src/core/energy';

/**
 * The questions in this file are the owner's own, verbatim. Until this
 * module existed the application recorded every fact needed to answer
 * them and aggregated none of it: v_daily_totals was only ever read one
 * date at a time.
 */

let db: Db;
let rice: number;
let dal: number;
const TODAY = '2026-08-23';

/** Days before TODAY, as YYYY-MM-DD. */
const dayBefore = (n: number): string => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

function eat(food: number, date: string, grams: number, at = '13:00:00'): void {
  db.run(
    `INSERT INTO log_entry (eaten_at, food_id, quantity, unit_id, grams_resolved,
                            status, created_at)
     VALUES (?,?,?,?,?,'resolved',?)`,
    [`${date}T${at}`, food, 1, unitId(db, 'g'), grams, `${date}T${at}`],
  );
}

function nutrient(food: number, key: string, per100g: number): void {
  db.run(`INSERT INTO food_nutrient (food_id, nutrient, per_100g, rel_error)
          VALUES (?,?,?,0.2)`, [food, key, per100g]);
}

function weigh(date: string, kg: number): void {
  db.run(
    `INSERT INTO body_profile (recorded_at, sex, age_years, height_cm, weight_kg,
                               activity_factor, goal_rate_kg_per_week, goal_weight_kg)
     VALUES (?,'male',34,178,?,1.465,-0.4,72)`,
    [`${date}T07:00:00`, kg],
  );
}

beforeEach(() => {
  db = freshDb();
  // 100 g of rice is 130 kcal and 2.7 g protein; dal is 116 kcal and 9 g.
  rice = addFood(db, 'Rice, cooked', 130);
  dal = addFood(db, 'Dal, cooked', 116);
  nutrient(rice, 'protein_g', 2.7);
  nutrient(rice, 'fibre_g', 0.4);
  nutrient(dal, 'protein_g', 9);
  nutrient(dal, 'fibre_g', 4.5);
});

// ------------------------------------------------------------------
describe('why has my weight stopped dropping', () => {
  it('reports a rate, which start-versus-current cannot', () => {
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + i * 0.05);

    const trend = weightTrend(db, 28, TODAY);
    expect(trend).not.toBeNull();
    // 0.05 kg/day lost going forward = 0.35 kg/week.
    expect(trend!.kgPerWeek).toBeCloseTo(-0.35, 2);
    expect(trend!.r2).toBeGreaterThan(0.99);
  });

  it('sees a plateau that start-versus-current reports as steady loss', () => {
    // Two weeks of real loss, then two weeks of nothing. This is the
    // exact shape of the owner's question, and the reason a first-to-
    // last comparison cannot answer it: the endpoints are unchanged by
    // where the loss actually happened.
    for (let i = 27; i >= 14; i--) weigh(dayBefore(i), 76.8 - (27 - i) * 0.1);
    for (let i = 13; i >= 0; i--) weigh(dayBefore(i), 75.4);

    expect(weightProgress(db)!.lostKg).toBe(1.4);          // "you have lost 1.4 kg"
    // ...while the last fortnight moved nothing at all.
    expect(Math.abs(weightTrend(db, 13, TODAY)!.kgPerWeek)).toBeLessThan(0.01);
  });

  it('refuses a trend from too few readings', () => {
    weigh(dayBefore(10), 76);
    weigh(dayBefore(0), 75.4);
    // Two points always fit a line perfectly. That is not a trend.
    expect(weightTrend(db, 28, TODAY)).toBeNull();
  });

  it('reports how well the line actually fits', () => {
    // Daily weight moves kilograms on water alone. A confident rate
    // from a scatter no line describes is the sort of number this
    // application exists not to emit.
    for (let i = 20; i >= 0; i--) weigh(dayBefore(i), 75 + (i % 3) - 1);
    const trend = weightTrend(db, 28, TODAY)!;
    expect(trend.r2).toBeLessThan(0.2);
  });
});

// ------------------------------------------------------------------
describe('is my protein historically low', () => {
  beforeEach(() => {
    db.run(`INSERT INTO energy_target (log_date, source, kcal, computed_at)
            SELECT ?, 'manual', 2000, ?`, [TODAY, `${TODAY}T00:00:00`]);
  });

  it('averages what was logged, against the macro budget', () => {
    for (let i = 13; i >= 0; i--) eat(rice, dayBefore(i), 500);   // 650 kcal, 13.5 g protein

    const protein = nutrientHabits(db, 14, TODAY).find((h) => h.nutrient === 'protein_g')!;
    expect(protein.meanPerDay).toBeCloseTo(13.5, 1);
    // 20% of 2000 kcal at 4 kcal/g = 100 g.
    expect(protein.targetPerDay).toBe(100);
    expect(protein.adherence).toBeCloseTo(0.135, 2);
  });

  it('does not count a day you did not log as a day you ate nothing', () => {
    // Averaging gaps in as zeros would make every missed day look like
    // restraint, which is the inverse of the truth.
    eat(rice, dayBefore(1), 500);
    eat(rice, dayBefore(0), 500);

    const energy = nutrientHabits(db, 14, TODAY).find((h) => h.nutrient === 'kcal')!;
    expect(energy.nDays).toBe(2);
    expect(energy.meanPerDay).toBeCloseTo(650, 0);
  });
});

// ------------------------------------------------------------------
describe('how much do I normally eat on training days', () => {
  it('splits by whether a session actually happened', () => {
    for (let i = 9; i >= 0; i--) {
      const trained = i % 2 === 0;
      eat(rice, dayBefore(i), trained ? 800 : 400);
      if (trained) {
        db.run('INSERT INTO workout_session (started_at, duration_min, kind) VALUES (?,?,?)',
          [`${dayBefore(i)}T06:30:00`, 45, 'running']);
      }
    }

    const split = trainingDayIntake(db, 14, TODAY);
    expect(split.nOn).toBe(5);
    expect(split.nOff).toBe(5);
    expect(split.onKcal).toBeCloseTo(1040, 0);
    expect(split.offKcal).toBeCloseTo(520, 0);
    expect(split.differenceKcal).toBeCloseTo(520, 0);
  });

  it('says how many days it is speaking for', () => {
    // "You eat 400 more on training days" from two days is not a habit.
    expect(trainingDayIntake(db, 14, TODAY).basis).toContain('0 training days');
  });
});

// ------------------------------------------------------------------
describe('what does my normal week look like', () => {
  it('groups intake by day of the week', () => {
    // Four Saturdays of eating considerably more.
    for (let i = 27; i >= 0; i--) {
      const isSat = new Date(`${dayBefore(i)}T12:00:00Z`).getUTCDay() === 6;
      eat(rice, dayBefore(i), isSat ? 1000 : 400);
    }

    const week = weekProfile(db, 28, TODAY);
    const sat = week.find((d) => d.label === 'Saturday')!;
    const wed = week.find((d) => d.label === 'Wednesday')!;
    expect(sat.meanKcal!).toBeGreaterThan(wed.meanKcal!);
    expect(sat.nDays).toBeGreaterThanOrEqual(4);
  });

  it('returns every weekday, including ones with no data', () => {
    // A silent gap in a weekly profile reads as a zero.
    const week = weekProfile(db, 28, TODAY);
    expect(week).toHaveLength(7);
    expect(week.every((d) => d.meanKcal === null)).toBe(true);
  });
});

// ------------------------------------------------------------------
describe('what do I actually eat', () => {
  it('ranks by how often, not by how much', () => {
    for (let i = 9; i >= 0; i--) eat(dal, dayBefore(i), 150);
    eat(rice, dayBefore(0), 2000);

    const habits = foodHabits(db, 28, 10, TODAY);
    expect(habits[0].name).toBe('Dal, cooked');
    expect(habits[0].nEntries).toBe(10);
    expect(habits[0].nDays).toBe(10);
  });
});

// ------------------------------------------------------------------
describe('what is my actual maintenance intake', () => {
  it('reports the target gap and the scale gap separately', () => {
    // They disagree, and the disagreement is the useful part: either
    // the logging is drifting or the target is wrong.
    for (let i = 27; i >= 0; i--) {
      eat(rice, dayBefore(i), 1000);                       // 1300 kcal logged
      weigh(dayBefore(i), 75.4 + i * 0.02);                // 0.14 kg/week down
      db.run(`INSERT INTO energy_target (log_date, source, kcal, computed_at)
              VALUES (?,'manual',1800,?)`, [dayBefore(i), `${dayBefore(i)}T00:00:00`]);
    }

    const bal = energyBalance(db, 28, TODAY);
    expect(bal.meanIntakeKcal).toBeCloseTo(1300, 0);
    expect(bal.meanTargetKcal).toBeCloseTo(1800, 0);
    expect(bal.gapKcal).toBeCloseTo(-500, 0);
    // -0.14 kg/week x 7000 / 7 = about -140 kcal/day, nowhere near -500.
    expect(bal.impliedGapKcal).toBeCloseTo(-140, 0);
  });

  it('says plainly when there is not enough weight data', () => {
    eat(rice, dayBefore(0), 500);
    expect(energyBalance(db, 28, TODAY).impliedGapKcal).toBeNull();
    expect(energyBalance(db, 28, TODAY).basis).toContain('not enough weight readings');
  });
});
