import { beforeEach, describe, expect, it } from 'vitest';
import { addFood, freshDb, unitId } from './helpers';
import type { Db } from '../src/core/db';
import { decide } from '../src/core/advice';

/**
 * The owner's question, with the owner's own numbers:
 *
 *   Goal 72 kg, current 75.4, trend -0.32/week, target -0.40/week.
 *   Sleep poor, HRV down, training load high.
 *   Protein and fibre historically low.
 *   "What is the best decision I can make right now?"
 *
 * The answer this file pins is NOT "eat 400 fewer calories". It is that
 * recovery gates the energy advice, and composition is the lever that
 * costs nothing. Getting that wrong is the most common way a plan stops
 * working, so it is the invariant most worth a test.
 */

let db: Db;
let rice: number;
let dal: number;
let paneer: number;
const TODAY = '2026-08-23';

const dayBefore = (n: number): string => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const nutrient = (food: number, key: string, per100g: number) =>
  db.run(`INSERT INTO food_nutrient (food_id, nutrient, per_100g, rel_error)
          VALUES (?,?,?,0.2)`, [food, key, per100g]);

const eat = (food: number, date: string, grams: number) =>
  db.run(`INSERT INTO log_entry (eaten_at, food_id, quantity, unit_id, grams_resolved,
                                 status, created_at)
          VALUES (?,?,1,?,?,'resolved',?)`,
    [`${date}T13:00:00`, food, unitId(db, 'g'), grams, `${date}T13:00:00`]);

const weigh = (date: string, kg: number, rate = -0.4) =>
  db.run(`INSERT INTO body_profile (recorded_at, sex, age_years, height_cm, weight_kg,
                                    activity_factor, goal_rate_kg_per_week, goal_weight_kg)
          VALUES (?,'male',34,178,?,1.465,?,72)`, [`${date}T07:00:00`, kg, rate]);

const metric = (date: string, key: string, value: number) =>
  db.run(`INSERT INTO daily_metric (log_date, metric, value, source, recorded_at)
          VALUES (?,?,?,'garmin',?)`, [date, key, value, `${date}T08:00:00`]);

const target = (date: string, kcal: number) =>
  db.run(`INSERT INTO energy_target (log_date, source, kcal, computed_at)
          VALUES (?,'manual',?,?)`, [date, kcal, `${date}T00:00:00`]);

/**
 * 28 days of the owner's stated situation.
 *
 * `riceG` sets the logged intake. The default makes the log AGREE with
 * the scale (1680 kcal against a 2000 target is -320 kcal/day, which is
 * the -0.32 kg/week the weight series shows). Tests that want the
 * disagreement path ask for it explicitly, because a disagreement is
 * the more urgent finding and correctly shadows everything else.
 */
function ownersSituation({ strained, riceG = 1292, lossKgWeek = 0.32 }:
  { strained: boolean; riceG?: number; lossKgWeek?: number }): void {
  for (let i = 27; i >= 0; i--) {
    const d = dayBefore(i);
    weigh(d, 75.4 + (i * lossKgWeek) / 7);
    if (riceG > 0) eat(rice, d, riceG);  // 130 kcal, 2.7 g protein, 0.4 g fibre /100 g
    target(d, 2000);
    db.run(`INSERT INTO daily_logging_stats (log_date, entry_count, pending_count,
              weighed_fraction, fastpath_fraction, model_eligible)
            VALUES (?,4,0,0.8,0.9,1)`, [d]);

    if (strained) {
      metric(d, 'sleep_min', i <= 2 ? 300 : 430);      // recent nights short
      metric(d, 'hrv_ms', i <= 2 ? 38 : 58);           // and HRV down
      if (i <= 2) {
        db.run('INSERT INTO workout_session (started_at, duration_min, kind) VALUES (?,?,?)',
          [`${d}T06:30:00`, 75, 'running']);
        db.run(`INSERT INTO session_energy (session_id, source, kcal, recorded_at)
                SELECT id, 'garmin', 900, ? FROM workout_session
                 WHERE started_at = ?`, [`${d}T08:00:00`, `${d}T06:30:00`]);
      }
    } else {
      metric(d, 'sleep_min', 430);
      metric(d, 'hrv_ms', 58);
    }
  }
}

beforeEach(() => {
  db = freshDb();
  rice = addFood(db, 'Rice, cooked', 130);
  dal = addFood(db, 'Dal, cooked', 116);
  paneer = addFood(db, 'Paneer', 265);
  nutrient(rice, 'protein_g', 2.7); nutrient(rice, 'fibre_g', 0.4);
  nutrient(dal, 'protein_g', 9);    nutrient(dal, 'fibre_g', 4.5);
  nutrient(paneer, 'protein_g', 18); nutrient(paneer, 'fibre_g', 0);
});

describe('recovery gates the energy advice', () => {
  it('refuses to deepen the deficit when sleep and HRV are down', () => {
    // Losing 0.15 kg/week against a 0.40 target: the arithmetic says
    // cut 250 kcal. The body says no. This is the single rule worth
    // having a recommendation engine for at all.
    ownersSituation({ strained: true, lossKgWeek: 0.15 });

    const { decisions } = decide(db, TODAY);
    const energy = decisions.find((d) => d.kind === 'energy')!;
    expect(energy.headline).toMatch(/hold the current intake/i);
    expect(energy.because.join(' ')).toMatch(/recovery signals are down/);

    const recovery = decisions.find((d) => d.kind === 'recovery')!;
    expect(recovery.headline).toMatch(/do not deepen the deficit/i);
  });

  it('does prescribe a cut when recovery is fine', () => {
    // Same shortfall, same goal, different body. The advice must
    // actually change, or the gate above is decoration.
    ownersSituation({ strained: false, lossKgWeek: 0.15 });

    const energy = decide(db, TODAY).decisions.find((d) => d.kind === 'energy')!;
    expect(energy.headline).toMatch(/take about \d+ kcal\/day off/i);
  });

  it('says nothing about energy at all without a weight trend', () => {
    // No weight series, no rate, no honest advice about a rate.
    for (let i = 20; i >= 0; i--) { eat(rice, dayBefore(i), 800); target(dayBefore(i), 2000); }
    const { decisions } = decide(db, TODAY);
    expect(decisions.some((d) => d.headline.match(/kcal\/day off/i))).toBe(false);
    expect(decisions.some((d) => d.headline.match(/weigh yourself more often/i))).toBe(true);
  });
});

describe('a shortfall inside the noise is not a shortfall', () => {
  it("calls the owner's own numbers on track rather than inventing a cut", () => {
    // -0.32 against a -0.40 target is 0.08 kg/week, which is 80 kcal a
    // day - well inside the error of food logging itself. Prescribing
    // a change to chase it would be false precision, which is the one
    // thing this application is built not to do.
    ownersSituation({ strained: false });
    const energy = decide(db, TODAY).decisions.find((d) => d.kind === 'energy')!;
    expect(energy.headline).toMatch(/on track/i);
  });
});

describe('composition is the lever that costs nothing', () => {
  it('names foods from your own log, not an ideal diet', () => {
    // Advice to eat something you have never eaten is advice you will
    // not take.
    ownersSituation({ strained: true, lossKgWeek: 0.15 });
    for (let i = 20; i >= 0; i--) eat(dal, dayBefore(i), 150);
    for (let i = 20; i >= 0; i--) eat(paneer, dayBefore(i), 60);

    const protein = decide(db, TODAY).decisions
      .find((d) => d.kind === 'composition' && d.headline.includes('protein'))!;
    expect(protein).toBeDefined();
    expect(protein.headline).toMatch(/without adding calories/);
    // Paneer is the densest protein among foods actually eaten.
    expect(protein.because.join(' ')).toContain('Paneer');
  });

  it('flags fibre on the same basis', () => {
    ownersSituation({ strained: true, lossKgWeek: 0.15 });
    const fibre = decide(db, TODAY).decisions
      .find((d) => d.headline.includes('fibre'));
    expect(fibre).toBeDefined();
    expect(fibre!.because[0]).toMatch(/g\/day against a \d+ g target/);
  });

  it('stays quiet when a nutrient is already close to target', () => {
    // Never nag about something that is fine.
    ownersSituation({ strained: false, riceG: 0 });
    for (let i = 27; i >= 0; i--) eat(paneer, dayBefore(i), 550);   // ~99 g protein
    const protein = decide(db, TODAY).decisions
      .find((d) => d.kind === 'composition' && d.headline.includes('protein'));
    expect(protein).toBeUndefined();
  });
});

describe('it says when it should not be trusted', () => {
  it('surfaces a log-versus-scale disagreement instead of picking one', () => {
    // Eating 1040 against a 2000 target should lose about 0.96 kg/week.
    // The scale says 0.32. One of the two is wrong, the app does not
    // know which, so it must not pretend to.
    ownersSituation({ strained: false, riceG: 800 });
    const energy = decide(db, TODAY).decisions.find((d) => d.kind === 'energy')!;
    expect(energy.headline).toMatch(/log and your scale disagree/i);
    expect(energy.confidenceBasis).toMatch(/daily_logging_stats/);
  });

  it('marks the whole answer provisional on thin data', () => {
    eat(rice, dayBefore(0), 800);
    expect(decide(db, TODAY).provisional).toBe(true);
  });

  it('is not provisional once there is a month of both', () => {
    ownersSituation({ strained: false });
    expect(decide(db, TODAY).provisional).toBe(false);
  });

  it('tells you to fix the logging before changing the plan', () => {
    ownersSituation({ strained: false });
    db.run(`UPDATE daily_logging_stats SET model_eligible = 0
             WHERE log_date > date(?, '-14 days')`, [TODAY]);
    const fix = decide(db, TODAY).decisions.find((d) => d.kind === 'consistency')!;
    expect(fix.headline).toMatch(/fix the logging/i);
  });

  it('every decision carries the figures it came from', () => {
    // A recommendation with no working shown is exactly what this
    // application exists not to produce.
    ownersSituation({ strained: true, lossKgWeek: 0.15 });
    for (const d of decide(db, TODAY).decisions) {
      expect(d.because.length, d.headline).toBeGreaterThan(0);
      expect(d.confidenceBasis, d.headline).not.toBe('');
    }
  });
});
