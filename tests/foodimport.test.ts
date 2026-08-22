import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from './helpers';
import type { Db } from '../src/core/db';
import { DEFAULT_REL_ERROR, loadFoods, parseFoodCsv } from '../src/core/foodimport';
import { dayTotals } from '../src/core/totals';

let db: Db;
beforeEach(() => { db = freshDb(); });

const CSV = [
  'food_code,food_name,energy_kcal,protein,fat,carbohydrate,total_fibre,vitamin_b12',
  'A001,Wheat flour whole,341,12.1,1.7,71.2,11.4,0',
  'A002,Rajma cooked,118,7.6,0.4,20.1,6.4,',
  'A003,Water,,0,0,0,0,0',
].join('\n');

describe('food reference loading', () => {
  it('maps nutrient columns it knows and reports the ones it does not', () => {
    const { records, unmapped } = parseFoodCsv(CSV);
    expect(records[0].nutrients).toEqual({
      kcal: 341, protein_g: 12.1, fat_g: 1.7, carb_g: 71.2, fibre_g: 11.4,
    });
    // Ignored, not guessed at.
    expect(unmapped).toEqual(['vitamin_b12']);
  });

  it('treats a blank cell as missing, not as zero', () => {
    const { records } = parseFoodCsv(CSV);
    const rajma = records.find((r) => r.name === 'Rajma cooked')!;
    expect('fibre_g' in rajma.nutrients).toBe(true);
    expect(rajma.nutrients).not.toHaveProperty('vitamin_b12');
  });

  it('stores source and source_ref on every food', () => {
    const { records } = parseFoodCsv(CSV);
    loadFoods(db, records, 'indb');
    const row = db.get<{ source: string; source_ref: string; source_fetched: string }>(
      "SELECT source, source_ref, source_fetched FROM food WHERE name = 'Wheat flour whole'",
    );
    expect(row).toMatchObject({ source: 'indb', source_ref: 'A001' });
    expect(row!.source_fetched).toBeTruthy();
  });

  it('stores the error band the source is actually good for', () => {
    const { records } = parseFoodCsv(CSV);
    loadFoods(db, records, 'label');
    const row = db.get<{ rel_error: number }>(
      "SELECT rel_error FROM food_nutrient WHERE nutrient = 'kcal' LIMIT 1",
    );
    // FSSAI permits ±20–25% on a declared label value, so stored precision
    // must not pretend to exceed real precision.
    expect(row!.rel_error).toBe(DEFAULT_REL_ERROR.label);
    expect(row!.rel_error).toBeGreaterThan(DEFAULT_REL_ERROR.indb);
  });

  it('skips a row with no energy value rather than storing a zero', () => {
    const { records } = parseFoodCsv(CSV);
    const report = loadFoods(db, records, 'indb');
    expect(report.skipped).toEqual(['Water']);
    expect(db.get("SELECT 1 FROM food WHERE name = 'Water'")).toBeUndefined();
  });

  it('is idempotent — reloading the same file updates rather than duplicates', () => {
    const { records } = parseFoodCsv(CSV);
    loadFoods(db, records, 'indb');
    const second = loadFoods(db, records, 'indb');
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);
    expect(db.all('SELECT * FROM food')).toHaveLength(2);
  });

  it('keeps the same food from two sources apart', () => {
    const { records } = parseFoodCsv(CSV);
    loadFoods(db, records, 'indb');
    loadFoods(db, records, 'ifct2017');
    expect(db.all('SELECT * FROM food')).toHaveLength(4);
  });

  it('carries the loaded error band all the way into the daily total', () => {
    const { records } = parseFoodCsv(CSV);
    loadFoods(db, records, 'label');
    const foodId = db.get<{ id: number }>("SELECT id FROM food WHERE name = 'Rajma cooked'")!.id;
    db.run(
      `INSERT INTO log_entry (eaten_at, food_id, quantity, unit_id, grams_resolved, status, created_at)
       VALUES ('2026-08-22T13:00:00', ?, 100, (SELECT id FROM unit WHERE code='g'), 100, 'resolved', '2026-08-22T13:00:00')`,
      [foodId],
    );
    const kcal = dayTotals(db, '2026-08-22').nutrients.find((n) => n.nutrient === 'kcal')!;
    expect(kcal.total).toBeCloseTo(118, 6);
    expect(kcal.absError).toBeCloseTo(118 * DEFAULT_REL_ERROR.label, 6);
  });
});
