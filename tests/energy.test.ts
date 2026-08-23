import { beforeEach, describe, expect, it } from 'vitest';
import { addFood, calibrate, freshDb, indexPhrase } from './helpers';
import type { Db } from '../src/core/db';
import {
  ACTIVITY_LEVELS, GOAL_RATES, KCAL_PER_KG, SAFE_FLOOR_KCAL,
  activeTarget, allTargets, bmrHarris, bmrKatch, bmrMifflin, clearManualTarget,
  currentProfile, estimateTargets, goalDelta, mealTargets, safetyCheck,
  saveProfile, setManualTarget, tdee, writeTargets, type BodyProfile,
} from '../src/core/energy';
import { handleUtterance } from '../src/core/resolve';
import { refreshWindows } from '../src/core/mealslot';

let db: Db;
beforeEach(() => { db = freshDb(); });

/** 30-year-old man, 180 cm, 80 kg, moderately active, losing 0.5 kg/week. */
const MAN: BodyProfile = {
  sex: 'male', ageYears: 30, heightCm: 180, weightKg: 80,
  bodyFatPct: null, activityFactor: 1.55, goalRateKgPerWeek: -0.5,
};
const WOMAN: BodyProfile = { ...MAN, sex: 'female', weightKg: 65, heightCm: 165 };

// -----------------------------------------------------------------
// The published equations, checked by hand.
// -----------------------------------------------------------------
describe('BMR formulas', () => {
  it('computes Mifflin-St Jeor for a man', () => {
    // 10(80) + 6.25(180) - 5(30) + 5 = 800 + 1125 - 150 + 5
    expect(bmrMifflin(MAN)).toBeCloseTo(1780, 6);
  });

  it('computes Mifflin-St Jeor for a woman', () => {
    // 10(65) + 6.25(165) - 5(30) - 161 = 650 + 1031.25 - 150 - 161
    expect(bmrMifflin(WOMAN)).toBeCloseTo(1370.25, 6);
  });

  it('computes revised Harris-Benedict for a man', () => {
    // 13.397(80) + 4.799(180) - 5.677(30) + 88.362
    expect(bmrHarris(MAN)).toBeCloseTo(1071.76 + 863.82 - 170.31 + 88.362, 4);
  });

  it('computes revised Harris-Benedict for a woman', () => {
    expect(bmrHarris(WOMAN)).toBeCloseTo(
      9.247 * 65 + 3.098 * 165 - 4.330 * 30 + 447.593, 4);
  });

  it('computes Katch-McArdle from lean mass', () => {
    // 20% fat of 80 kg leaves 64 kg lean: 370 + 21.6(64)
    expect(bmrKatch({ ...MAN, bodyFatPct: 20 })).toBeCloseTo(370 + 21.6 * 64, 6);
  });

  it('refuses Katch-McArdle without a real body-fat figure', () => {
    // Guessing body fat to feed the one formula whose advantage is
    // measured lean mass would be theatre.
    expect(bmrKatch(MAN)).toBeNull();
    expect(bmrKatch({ ...MAN, bodyFatPct: 120 })).toBeNull();
  });
});

describe('maintenance and goal deltas', () => {
  it('scales BMR by the activity factor', () => {
    expect(tdee(1780, 1.55)).toBeCloseTo(2759, 6);
  });

  it('derives the deficit from energy density, not a magic number', () => {
    expect(goalDelta(-0.5)).toBeCloseTo((-0.5 * KCAL_PER_KG) / 7, 6);
    // 500, not 550: calculator.net maps 1 kg/week to 1000 kcal/day.
    expect(goalDelta(-0.5)).toBeCloseTo(-500, 0);
    expect(goalDelta(-1)).toBeCloseTo(-1000, 0);
    expect(goalDelta(0)).toBe(0);
    expect(goalDelta(0.25)).toBeGreaterThan(0);
  });

  it('uses calculator.net activity multipliers, not the classic set', () => {
    // The classic Harris-Benedict ladder is 1.2/1.375/1.55/1.725/1.9.
    // calculator.net inserts 1.465 at "moderate" and shifts the rest
    // down, which is what its published output actually reproduces.
    expect(ACTIVITY_LEVELS.map((a) => a.factor))
      .toEqual([1.2, 1.375, 1.465, 1.55, 1.725, 1.9]);
  });

  it('offers loss, maintenance and gain', () => {
    const rates = GOAL_RATES.map((g) => g.rate);
    expect(rates).toContain(0);
    expect(rates.some((r) => r < 0)).toBe(true);
    expect(rates.some((r) => r > 0)).toBe(true);
  });
});

// -----------------------------------------------------------------
// Principle 9 applied to targets.
// -----------------------------------------------------------------
describe('every formula is kept, none are averaged', () => {
  it('returns one estimate per formula that can run', () => {
    expect(estimateTargets(MAN).map((e) => e.source)).toEqual(['mifflin', 'harris']);
    expect(estimateTargets({ ...MAN, bodyFatPct: 20 }).map((e) => e.source))
      .toEqual(['mifflin', 'harris', 'katch']);
  });

  it('never reports a mean of the formulas', () => {
    const est = estimateTargets({ ...MAN, bodyFatPct: 20 });
    const mean = est.reduce((s, e) => s + e.target, 0) / est.length;
    // The formulas genuinely disagree; the disagreement is information,
    // and a mean of three estimates is not more accurate than the best of
    // them, only more confident-looking.
    expect(new Set(est.map((e) => e.target)).size).toBeGreaterThan(1);
    for (const e of est) expect(e.target).not.toBe(Math.round(mean));
  });

  it('carries the arithmetic in the basis string', () => {
    const [mifflin] = estimateTargets(MAN);
    expect(mifflin.basis).toContain('mifflin BMR 1780');
    expect(mifflin.basis).toContain('activity 1.55');
    expect(mifflin.basis).toContain('kg/week');
  });

  it('applies the deficit to maintenance', () => {
    const [m] = estimateTargets(MAN);
    expect(m.maintenance).toBe(Math.round(1780 * 1.55));
    expect(m.target).toBe(Math.round(1780 * 1.55 + goalDelta(-0.5)));
  });

  it('stores each estimate in its own row', () => {
    writeTargets(db, { ...MAN, bodyFatPct: 20 }, '2026-08-22');
    const rows = allTargets(db, '2026-08-22');
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['mifflin', 'harris', 'katch']));
  });

  it('emits exactly one active target however many estimates exist', () => {
    writeTargets(db, { ...MAN, bodyFatPct: 20 }, '2026-08-22');
    expect(db.all('SELECT * FROM v_energy_target WHERE log_date = ?', ['2026-08-22']))
      .toHaveLength(1);
  });

  it('prefers Mifflin among the formulas', () => {
    writeTargets(db, { ...MAN, bodyFatPct: 20 }, '2026-08-22');
    expect(activeTarget(db, '2026-08-22')!.source).toBe('mifflin');
  });

  it('is idempotent for a day', () => {
    writeTargets(db, MAN, '2026-08-22');
    writeTargets(db, MAN, '2026-08-22');
    expect(allTargets(db, '2026-08-22')).toHaveLength(2);
  });
});

// -----------------------------------------------------------------
// Principle 8: the user's own decision wins.
// -----------------------------------------------------------------
describe('a manual target outranks every formula', () => {
  it('takes precedence once set', () => {
    writeTargets(db, MAN, '2026-08-22');
    setManualTarget(db, 2100, '2026-08-22');
    const active = activeTarget(db, '2026-08-22')!;
    expect(active).toMatchObject({ source: 'manual', kcal: 2100 });
  });

  it('keeps the formula estimates alongside it rather than deleting them', () => {
    writeTargets(db, MAN, '2026-08-22');
    setManualTarget(db, 2100, '2026-08-22');
    expect(allTargets(db, '2026-08-22').length).toBeGreaterThan(1);
  });

  it('falls back to the formulas when cleared', () => {
    writeTargets(db, MAN, '2026-08-22');
    setManualTarget(db, 2100, '2026-08-22');
    clearManualTarget(db, '2026-08-22');
    expect(activeTarget(db, '2026-08-22')!.source).toBe('mifflin');
  });
});

describe('safety floor warns but never blocks', () => {
  it('flags a target below the floor', () => {
    const note = safetyCheck(WOMAN, 900);
    expect(note.belowFloor).toBe(true);
    expect(note.floor).toBe(SAFE_FLOOR_KCAL.female);
    expect(note.message).toContain('below the 1200');
  });

  it('stores the number exactly as asked, unclamped', () => {
    // "Explain the consequence once, then do exactly what I asked."
    setManualTarget(db, 900, '2026-08-22');
    expect(activeTarget(db, '2026-08-22')!.kcal).toBe(900);
  });

  it('says nothing when the target is above the floor', () => {
    expect(safetyCheck(MAN, 2200).message).toBeNull();
  });
});

// -----------------------------------------------------------------
// Profile history.
// -----------------------------------------------------------------
describe('body profile is append-only', () => {
  it('keeps every recorded profile', () => {
    saveProfile(db, MAN);
    saveProfile(db, { ...MAN, weightKg: 78 });
    expect(db.all('SELECT * FROM body_profile')).toHaveLength(2);
  });

  it('reads back the most recent as current', () => {
    saveProfile(db, MAN);
    saveProfile(db, { ...MAN, weightKg: 78 });
    expect(currentProfile(db)!.weightKg).toBe(78);
  });

  it('returns null before anything is recorded', () => {
    expect(currentProfile(db)).toBeNull();
  });

  it('round-trips a null body-fat figure rather than inventing one', () => {
    saveProfile(db, MAN);
    expect(currentProfile(db)!.bodyFatPct).toBeNull();
  });
});

// -----------------------------------------------------------------
// Splitting the target across meals.
// -----------------------------------------------------------------
describe('per-meal targets', () => {
  const seedWindows = () => {
    const stamps = ['2026-08-20', '2026-08-21'].flatMap((d) =>
      ['08:15', '13:20', '20:45'].map((t) => `${d}T${t}:00`));
    for (const t of stamps) {
      db.run(
        `INSERT INTO imported_entry (source, eaten_at, food_text, portion_text, meal_label, imported_at)
         VALUES ('healthify', ?, 'X', NULL, NULL, '2026-08-22T00:00:00')`, [t]);
    }
    refreshWindows(db, 'imported_entry');
  };

  it('returns nothing before any window is derived', () => {
    expect(mealTargets(db, 2000)).toEqual([]);
  });

  it('splits evenly until there is history to weight with', () => {
    seedWindows();
    const t = mealTargets(db, 2100);
    expect(t.map((x) => x.slot)).toEqual(['breakfast', 'lunch', 'dinner']);
    expect(t.every((x) => x.fromHistory === false)).toBe(true);
    expect(t.map((x) => x.kcal)).toEqual([700, 700, 700]);
  });

  it('weights by how you actually eat once there is enough history', () => {
    seedWindows();
    const roti = addFood(db, 'Roti', 300, { defaultUnit: 'piece' });
    indexPhrase(db, 'roti', roti, 1, 'piece');
    calibrate(db, 'piece', 100);

    // Dinner deliberately much larger than breakfast.
    const log = (slot: string, text: string, n: number) => {
      for (let i = 0; i < n; i++) {
        handleUtterance(db, {
          rawText: text, spokenAt: new Date('2026-08-22T12:00:00'), tzOffsetMin: 0,
        }, slot);
      }
    };
    log('breakfast', 'one roti', 4);
    log('lunch', 'one roti', 4);
    log('dinner', 'two rotis', 4);

    const t = mealTargets(db, 2000);
    expect(t.every((x) => x.fromHistory)).toBe(true);
    const dinner = t.find((x) => x.slot === 'dinner')!;
    const breakfast = t.find((x) => x.slot === 'breakfast')!;
    // Dinner is twice the intake, so twice the share.
    expect(dinner.kcal).toBeCloseTo(breakfast.kcal * 2, -1);
    expect(t.reduce((s, x) => s + x.kcal, 0)).toBeCloseTo(2000, -1);
  });
});

// -----------------------------------------------------------------
// Pinned to calculator.net's own published output.
//
// The owner supplied a screenshot of that calculator for a male aged 25,
// 180 cm, 65 kg, "Moderate: exercise 4-5 times/week". Reproducing those
// figures exactly is what caught two wrong constants here: the moderate
// activity factor is 1.465, not the classic Harris-Benedict 1.55, and
// the calculator maps 1 kg/week to 1000 kcal/day, i.e. 7000 kcal/kg
// rather than the physiological 7700.
// -----------------------------------------------------------------
describe('matches calculator.net for the reference profile', () => {
  const REF: BodyProfile = {
    sex: 'male', ageYears: 25, heightCm: 180, weightKg: 65,
    bodyFatPct: null, activityFactor: 1.465, goalRateKgPerWeek: 0,
  };

  it('computes the same BMR', () => {
    expect(bmrMifflin(REF)).toBeCloseTo(1655, 6);
  });

  it('computes the same maintenance figure', () => {
    const [m] = estimateTargets(REF);
    expect(m.maintenance).toBe(2425);
  });

  it.each([
    [-0.25, 2175, 90],
    [-0.5, 1925, 79],
    [-1, 1425, 59],
    [0.25, 2675, 110],
    [0.5, 2925, 121],
    [1, 3425, 141],
  ])('rate %s kg/week gives %s kcal (%s%% of maintenance)', (rate, kcal, pct) => {
    const [m] = estimateTargets({ ...REF, goalRateKgPerWeek: rate });
    expect(m.target).toBe(kcal);
    expect(m.percentOfMaintenance).toBe(pct);
  });

  it('flags the extreme-loss target as below the stated 1500 floor', () => {
    // calculator.net prints the same warning against this exact figure.
    const [m] = estimateTargets({ ...REF, goalRateKgPerWeek: -1 });
    const note = safetyCheck(REF, m.target);
    expect(m.target).toBe(1425);
    expect(note.belowFloor).toBe(true);
    expect(note.floor).toBe(1500);
  });
});
