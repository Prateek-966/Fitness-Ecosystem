import { readFileSync } from 'node:fs';
import { NodeDb } from '../src/platform/node-db';
import { initSchema } from '../src/core/db';
import type { Db } from '../src/core/db';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const SEED = readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8');

export function freshDb(): Db {
  const db = new NodeDb(':memory:');
  initSchema(db, SCHEMA, SEED);
  return db;
}

export function unitId(db: Db, code: string): number {
  return db.get<{ id: number }>('SELECT id FROM unit WHERE code = ?', [code])!.id;
}

/**
 * Foods carry provenance in the test fixtures too. A test that inserts a
 * nutrient value with no source would be testing a shape the app is not
 * allowed to produce.
 */
export function addFood(
  db: Db,
  name: string,
  kcalPer100g: number,
  opts: { source?: string; relError?: number; brand?: string | null; defaultUnit?: string } = {},
): number {
  const r = db.run(
    `INSERT INTO food (name, brand, is_composite, source, source_ref, created_at, default_unit_id)
     VALUES (?, ?, 0, ?, ?, ?, ?)`,
    [
      name, opts.brand ?? null, opts.source ?? 'indb', `test:${name}`,
      new Date().toISOString(),
      opts.defaultUnit ? unitId(db, opts.defaultUnit) : null,
    ],
  );
  db.run(
    'INSERT INTO food_nutrient (food_id, nutrient, per_100g, rel_error) VALUES (?,?,?,?)',
    [r.lastInsertRowid, 'kcal', kcalPer100g, opts.relError ?? 0.2],
  );
  return r.lastInsertRowid;
}

export function indexPhrase(
  db: Db, phrase: string, foodId: number, qty: number | null = null, unit: string | null = null,
): void {
  db.run(
    `INSERT INTO phrase_index (phrase, food_id, default_qty, default_unit_id, hit_count, last_used_at)
     VALUES (?,?,?,?,1,?)`,
    [phrase, foodId, qty, unit ? unitId(db, unit) : null, new Date().toISOString()],
  );
}

export function calibrate(
  db: Db, unit: string, grams: number,
  basis: 'weighed' | 'estimated' = 'weighed', foodId: number | null = null,
): void {
  // Upsert, exactly as recalibrate() does. A plain INSERT was safe only
  // while user_measure started empty; seed.sql now ships estimated
  // household measures so a new database can resolve "two rotis" at
  // all, and a fixture that calibrates one has to overwrite rather than
  // collide with it. The partial index is the conflict target because
  // SQLite treats NULL food_id values as distinct - the trap this
  // schema has already paid for three times.
  const id = unitId(db, unit);
  const at = new Date().toISOString();
  if (foodId === null) {
    db.run(
      `INSERT INTO user_measure (food_id, unit_id, grams, basis, calibrated_at)
       VALUES (NULL,?,?,?,?)
       ON CONFLICT(unit_id) WHERE food_id IS NULL DO UPDATE SET
         grams = excluded.grams, basis = excluded.basis,
         calibrated_at = excluded.calibrated_at`,
      [id, grams, basis, at],
    );
  } else {
    db.run(
      `INSERT INTO user_measure (food_id, unit_id, grams, basis, calibrated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(food_id, unit_id) DO UPDATE SET
         grams = excluded.grams, basis = excluded.basis,
         calibrated_at = excluded.calibrated_at`,
      [foodId, id, grams, basis, at],
    );
  }
}
