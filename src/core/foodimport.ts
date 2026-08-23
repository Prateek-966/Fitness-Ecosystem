import type { Db } from './db';
import { localIso } from './clock';
import { splitCsv } from './csv';

/**
 * Loader for food reference data.
 *
 * No nutrient value is ever written by application logic — every row that
 * lands in food_nutrient comes through here, from a file, carrying the
 * source it came from and the relative error that source is good for.
 *
 * INDB is the primary source: open access, ~1,095 items plus ~1,014
 * recipes with ingredient decomposition. IFCT 2017 is reference only —
 * it is personal-use licensed, so its derived values must never be
 * committed to a repository. The data directory is gitignored for exactly
 * that reason.
 */

export type FoodSource = 'indb' | 'ifct2017' | 'usda_fdc' | 'label'
  | 'user_defined' | 'starter';

/**
 * Default relative error by source. FSSAI permits ±20–25% tolerance on
 * declared label values, so a label figure is stored with a band that
 * reflects what a label actually promises rather than the two decimal
 * places it happens to print.
 */
export const DEFAULT_REL_ERROR: Record<FoodSource, number> = {
  indb: 0.10,
  ifct2017: 0.10,
  usda_fdc: 0.10,
  label: 0.22,
  user_defined: 0.25,
  // The starter bank is approximate reference data, shipped so the app
  // is usable on first open rather than being a dead end. It carries the
  // widest band deliberately: these are typical composition figures, not
  // values traced to a specific laboratory analysis, and the app should
  // say so in its error bars rather than imply a precision it has not
  // got. Loading a real table later overwrites them, because a food is
  // identified by (name, brand, source, source_ref).
  starter: 0.25,
};

export interface FoodRecord {
  name: string;
  /** Household measure this food is normally eaten in, e.g. 'piece'. */
  defaultUnit?: string | null;
  brand?: string | null;
  sourceRef?: string | null;
  isComposite?: boolean;
  nutrients: Record<string, number>;   // per 100 g edible portion
}

export interface LoadReport {
  inserted: number;
  updated: number;
  nutrientRows: number;
  source: FoodSource;
  skipped: string[];
}

/** Canonical nutrient keys. Anything not listed here is ignored, not guessed. */
const NUTRIENT_ALIASES: Record<string, string> = {
  energy_kcal: 'kcal', energy: 'kcal', kcal: 'kcal', calories: 'kcal',
  protein: 'protein_g', protein_g: 'protein_g',
  fat: 'fat_g', total_fat: 'fat_g', fat_g: 'fat_g',
  carb: 'carb_g', carbohydrate: 'carb_g', carbohydrates: 'carb_g', carb_g: 'carb_g',
  fibre: 'fibre_g', fiber: 'fibre_g', fibre_g: 'fibre_g', total_fibre: 'fibre_g',
  sugar: 'sugar_g', sugars: 'sugar_g', sugar_g: 'sugar_g',
  sodium: 'sodium_mg', sodium_mg: 'sodium_mg',
  iron: 'iron_mg', iron_mg: 'iron_mg',
  calcium: 'calcium_mg', calcium_mg: 'calcium_mg',
  zinc: 'zinc_mg', zinc_mg: 'zinc_mg',
};

export function canonicalNutrient(header: string): string | null {
  const k = header.trim().toLowerCase().replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
  return NUTRIENT_ALIASES[k] ?? null;
}

export function parseFoodCsv(csv: string): { records: FoodRecord[]; unmapped: string[] } {
  const rows = splitCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) return { records: [], unmapped: [] };

  const header = rows[0].map((c) => c.trim());
  const lower = header.map((c) => c.toLowerCase());
  const find = (...names: string[]) => {
    for (const n of names) {
      const i = lower.findIndex((h) => h === n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = lower.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iName = find('food_name', 'name', 'food', 'description');
  const iRef = find('food_code', 'code', 'id', 'fdc_id');
  const iBrand = find('brand');
  // The household measure this food is normally eaten in. Without it,
  // "two rotis" parses a quantity of two and has no unit to apply it
  // to, so the entry lands as pending forever - which is correct
  // behaviour for an unknown food and useless for a known one.
  const iUnit = find('default_unit', 'unit');
  if (iName < 0) return { records: [], unmapped: header };

  const nutrientCols: Array<[number, string]> = [];
  const unmapped: string[] = [];
  header.forEach((hcol, i) => {
    if (i === iName || i === iRef || i === iBrand || i === iUnit) return;
    const canon = canonicalNutrient(hcol);
    if (canon) nutrientCols.push([i, canon]);
    else unmapped.push(hcol);
  });

  const records: FoodRecord[] = [];
  for (const cells of rows.slice(1)) {
    const name = cells[iName]?.trim();
    if (!name) continue;
    const nutrients: Record<string, number> = {};
    for (const [i, key] of nutrientCols) {
      const v = Number(String(cells[i] ?? '').replace(/[^\d.eE+-]/g, ''));
      // A blank cell is missing data. Writing 0 for it would be inventing
      // a measurement, which is exactly what provenance exists to prevent.
      if (Number.isFinite(v) && String(cells[i] ?? '').trim() !== '') nutrients[key] = v;
    }
    if (Object.keys(nutrients).length === 0) continue;
    records.push({
      defaultUnit: iUnit >= 0 ? (cells[iUnit]?.trim() || null) : null,
      name,
      brand: iBrand >= 0 ? (cells[iBrand]?.trim() || null) : null,
      sourceRef: iRef >= 0 ? (cells[iRef]?.trim() || null) : null,
      nutrients,
    });
  }
  return { records, unmapped };
}

export function loadFoods(
  db: Db, records: FoodRecord[], source: FoodSource, relError?: number,
): LoadReport {
  const err = relError ?? DEFAULT_REL_ERROR[source];
  const fetched = localIso();
  let inserted = 0;
  let updated = 0;
  let nutrientRows = 0;
  const skipped: string[] = [];

  db.tx(() => {
    for (const r of records) {
      if (!r.nutrients.kcal && r.nutrients.kcal !== 0) { skipped.push(r.name); continue; }

      const existing = db.get<{ id: number }>(
        `SELECT id FROM food WHERE name = ? AND brand IS ? AND source = ? AND source_ref IS ?`,
        [r.name, r.brand ?? null, source, r.sourceRef ?? null],
      );

      let foodId: number;
      if (existing) {
        foodId = existing.id;
        db.run('UPDATE food SET source_fetched = ? WHERE id = ?', [fetched, foodId]);
        updated++;
      } else {
        foodId = db.run(
          `INSERT INTO food (name, brand, is_composite, source, source_ref, source_fetched, created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [r.name, r.brand ?? null, r.isComposite ? 1 : 0, source,
           r.sourceRef ?? null, fetched, fetched],
        ).lastInsertRowid;
        inserted++;
      }

      // Set only when the file names one and the unit is known. An
      // unrecognised unit name is dropped rather than invented, and a
      // file that says nothing leaves an existing default alone.
      if (r.defaultUnit) {
        const unit = db.get<{ id: number }>(
          'SELECT id FROM unit WHERE code = ?', [r.defaultUnit.toLowerCase()]);
        if (unit) {
          db.run('UPDATE food SET default_unit_id = ? WHERE id = ?', [unit.id, foodId]);
          db.run(`INSERT OR IGNORE INTO food_unit (food_id, unit_id) VALUES (?,?)`,
            [foodId, unit.id]);
        }
      }

      for (const [nutrient, per100g] of Object.entries(r.nutrients)) {
        db.run(
          `INSERT INTO food_nutrient (food_id, nutrient, per_100g, rel_error)
           VALUES (?,?,?,?)
           ON CONFLICT(food_id, nutrient) DO UPDATE SET
             per_100g = excluded.per_100g, rel_error = excluded.rel_error`,
          [foodId, nutrient, per100g, err],
        );
        nutrientRows++;
      }
    }
  });

  return { inserted, updated, nutrientRows, source, skipped };
}

