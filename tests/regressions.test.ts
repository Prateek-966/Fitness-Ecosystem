import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeDb } from '../src/platform/node-db';
import { initSchema } from '../src/core/db';
import { addFood, calibrate, freshDb, indexPhrase, unitId } from './helpers';
import type { Db } from '../src/core/db';
import { handleUtterance, recalibrate, resolveSlowPath, revise } from '../src/core/resolve';
import { localDate, localIso } from '../src/core/clock';
import { writeDayStats } from '../src/core/stats';
import { dayTotals, orphanItems } from '../src/core/totals';
import { importHealthify } from '../src/core/healthify';

let db: Db;
let roti: number;
let rajma: number;

const AT = new Date('2026-08-22T13:00:00.000Z');
const say = (text: string, at: Date = AT) =>
  handleUtterance(db, { rawText: text, spokenAt: at, tzOffsetMin: -at.getTimezoneOffset() });

beforeEach(() => {
  db = freshDb();
  roti = addFood(db, 'Roti, wheat', 297, { defaultUnit: 'piece' });
  rajma = addFood(db, 'Rajma curry', 118, { defaultUnit: 'katori' });
  indexPhrase(db, 'roti', roti, 1, 'piece');
  indexPhrase(db, 'rajma', rajma, 1, 'katori');
  calibrate(db, 'piece', 45);
  calibrate(db, 'katori', 150);
});

// -----------------------------------------------------------------
// Timestamps are device-local wall time, as the schema documents.
// -----------------------------------------------------------------
describe('local time storage', () => {
  it('formats local wall time with no zone suffix', () => {
    const iso = localIso(new Date());
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(iso.endsWith('Z')).toBe(false);
  });

  it('stores spoken_at and eaten_at as the same local instant', () => {
    const out = say('two rotis');
    const u = db.get<{ spoken_at: string }>('SELECT spoken_at FROM utterance WHERE id = ?', [out.utteranceId])!;
    const e = db.get<{ eaten_at: string }>('SELECT eaten_at FROM log_entry')!;
    expect(u.spoken_at).toBe(localIso(AT));
    expect(e.eaten_at).toBe(localIso(AT));
  });

  // The bug this section exists for: with UTC storage, an IST dinner at
  // 00:30 landed on yesterday. Only provable when the test runs in a
  // non-UTC zone, so it asserts under IST and is skipped elsewhere —
  // `npm test` runs the suite both ways.
  const ist = new Date().getTimezoneOffset() === -330;
  it.runIf(ist)('keeps a just-after-midnight IST log on the local day', () => {
    const lateNight = new Date('2026-08-21T19:30:00.000Z'); // 2026-08-22 01:00 IST
    say('two rotis', lateNight);
    expect(localDate(lateNight)).toBe('2026-08-22');
    const t = dayTotals(db, '2026-08-22');
    expect(t.nutrients.find((n) => n.nutrient === 'kcal')!.nEntries).toBe(1);
    expect(dayTotals(db, '2026-08-21').nutrients).toHaveLength(0);
  });
});

// -----------------------------------------------------------------
// Completing an entry is not un-matching it (criterion 2 integrity).
// -----------------------------------------------------------------
describe('match_method survives amount edits', () => {
  it('keeps exact_index when the queue supplies the missing amount', () => {
    const id = say('rajma').items[0].entryId!;
    revise(db, id, 'quantity', 2, 'quantity_supplied');
    const row = db.get<{ match_method: string; status: string }>(
      'SELECT match_method, status FROM log_entry WHERE id = ?', [id])!;
    expect(row).toMatchObject({ match_method: 'exact_index', status: 'resolved' });
    // ...so the completed entry still counts toward the fast-path fraction.
    expect(writeDayStats(db, '2026-08-22').fastpathFraction).toBe(1);
  });

  it('does mark a food-identity change as manual', () => {
    const id = say('two rotis').items[0].entryId!;
    revise(db, id, 'food_id', rajma, 'user_edit');
    expect(db.get<{ match_method: string }>(
      'SELECT match_method FROM log_entry WHERE id = ?', [id])!.match_method).toBe('manual');
  });
});

// -----------------------------------------------------------------
// Re-teaching a phrase moves the binding.
// -----------------------------------------------------------------
describe('the index obeys a correction', () => {
  it('rebinds a phrase when the slow path resolves it to a different food', () => {
    const wrong = addFood(db, 'Rajma, canned', 140);
    indexPhrase(db, 'rajma masala', wrong);
    const right = addFood(db, 'Rajma masala, home', 122);
    resolveSlowPath(db, {
      utteranceId: say('mmm').utteranceId,
      phrase: 'rajma masala', foodId: right,
      quantity: 1, unitId: unitId(db, 'katori'), eatenAt: AT,
    });
    expect(db.get<{ food_id: number }>(
      "SELECT food_id FROM phrase_index WHERE phrase = 'rajma masala'")!.food_id).toBe(right);
  });
});

// -----------------------------------------------------------------
// Calibrating a unit completes the entries that were waiting on it.
// -----------------------------------------------------------------
describe('calibration clears its own pending entries', () => {
  it('resolves an entry that was pending only for want of grams', () => {
    const chai = addFood(db, 'Chai', 60);
    indexPhrase(db, 'chai', chai);
    const out = say('two glasses chai');
    expect(out.items[0].reason).toBe('unit_uncalibrated');

    const n = recalibrate(db, unitId(db, 'glass'), null, 180, 'weighed');
    expect(n).toBe(1);
    const row = db.get<{ status: string; grams_resolved: number }>(
      'SELECT status, grams_resolved FROM log_entry WHERE food_id = ?', [chai])!;
    expect(row).toMatchObject({ status: 'resolved', grams_resolved: 360 });
  });
});

// -----------------------------------------------------------------
// weighed_fraction counts each entry once.
// -----------------------------------------------------------------
describe('weighed fraction', () => {
  it('does not double-count an entry that has two applicable measures', () => {
    // General katori estimated; rajma-specific katori weighed. The entry
    // resolves through the food-specific one, so the day is 100% weighed —
    // and one entry is one entry, not two.
    db.run("DELETE FROM user_measure WHERE unit_id = ?", [unitId(db, 'katori')]);
    calibrate(db, 'katori', 150, 'estimated');
    calibrate(db, 'katori', 210, 'weighed', rajma);
    say('one katori rajma');
    const s = writeDayStats(db, '2026-08-22');
    expect(s.entryCount).toBe(1);
    expect(s.weighedFraction).toBe(1);
  });
});

// -----------------------------------------------------------------
// Healthify re-import stays idempotent without portions.
// -----------------------------------------------------------------
describe('import idempotency with null portions', () => {
  it('does not duplicate portion-less rows on re-import', () => {
    const rows = [{ eatenAt: '2026-03-22T08:15:00', foodText: 'Poha', portionText: null, mealLabel: null }];
    importHealthify(db, rows);
    const second = importHealthify(db, rows);
    expect(second.inserted).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(db.all('SELECT * FROM imported_entry')).toHaveLength(1);
  });
});

// -----------------------------------------------------------------
// The slow-path queue is per phrase.
// -----------------------------------------------------------------
describe('multi-item slow path', () => {
  it('surfaces one queue row per unmatched phrase', () => {
    const out = say('one katori dal makhani and one pumpkin flower sabzi');
    expect(out.items.map((i) => i.action)).toEqual(['slow_path', 'slow_path']);
    const items = orphanItems(db);
    expect(items.map((i) => i.phrase).sort()).toEqual(['dal makhani', 'pumpkin flower sabzi']);
    expect(items.every((i) => i.utteranceId === out.utteranceId)).toBe(true);
  });

  it('clears the utterance only after every phrase is resolved', () => {
    const out = say('one katori dal makhani and one pumpkin flower sabzi');
    const dal = addFood(db, 'Dal makhani', 130);
    const sabzi = addFood(db, 'Pumpkin flower sabzi', 90);

    resolveSlowPath(db, {
      utteranceId: out.utteranceId, phrase: 'dal makhani',
      foodId: dal, quantity: 1, unitId: unitId(db, 'katori'), eatenAt: AT,
    });
    expect(orphanItems(db).map((i) => i.phrase)).toEqual(['pumpkin flower sabzi']);
    expect(db.get<{ processed_at: string | null }>(
      'SELECT processed_at FROM utterance WHERE id = ?', [out.utteranceId])!.processed_at).toBeNull();

    resolveSlowPath(db, {
      utteranceId: out.utteranceId, phrase: 'pumpkin flower sabzi',
      foodId: sabzi, quantity: 1, unitId: unitId(db, 'katori'), eatenAt: AT,
    });
    expect(orphanItems(db)).toHaveLength(0);
    expect(db.get<{ processed_at: string | null }>(
      'SELECT processed_at FROM utterance WHERE id = ?', [out.utteranceId])!.processed_at).not.toBeNull();
    expect(db.all('SELECT * FROM log_entry')).toHaveLength(2);
  });

  it('gives a parse-to-nothing utterance a raw-text row', () => {
    // "two katoris" parses to nothing — a unit with no food is ambiguity,
    // not an item — so there is no phrase to queue, only the transcript.
    say('two katoris');
    const items = orphanItems(db);
    expect(items).toHaveLength(1);
    expect(items[0].phrase).toBeNull();
    expect(items[0].rawText).toBe('two katoris');
  });
});

// -----------------------------------------------------------------
// Opening a database that predates part of the schema.
// -----------------------------------------------------------------
describe('a database created by an older version of the app', () => {
  const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const SEED = readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8');

  /** Every relation schema.sql declares, by name. */
  const declared = (kind: 'TABLE' | 'VIEW') =>
    [...SCHEMA.matchAll(new RegExp(`^CREATE ${kind}(?: IF NOT EXISTS)? (\\\\w+)`, 'gm'))]
      .map((m) => m[1]);

  it('gains the tables that were added after it was created', () => {
    // The real failure: an OPFS database created before goal setting
    // landed opened fine and then died on the first query, with
    // "no such table: body_profile". initSchema used to run schema.sql
    // only when a sentinel table was absent, so anything added later
    // never arrived.
    // Built by aging a real database rather than by hand-writing a
    // stub, which would drift from schema.sql and stop testing this.
    const old = new NodeDb(':memory:');
    initSchema(old, SCHEMA, SEED);
    old.exec('DROP TABLE body_profile');
    old.exec('DROP TABLE energy_target');

    initSchema(old, SCHEMA, SEED);

    const present = new Set(old.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view')").map((r) => r.name));
    for (const name of [...declared('TABLE'), ...declared('VIEW')]) {
      expect(present.has(name), `missing after upgrade: ${name}`).toBe(true);
    }
    expect(present.has('body_profile')).toBe(true);
  });

  it('gains columns added to a table it already had', () => {
    // IF NOT EXISTS skips the whole CREATE TABLE, so a new column on an
    // existing table needs its own path. This is that path.
    const old = new NodeDb(':memory:');
    initSchema(old, SCHEMA, SEED);
    old.exec('DROP TABLE workout_session');
    old.exec(`CREATE TABLE workout_session (
      id INTEGER PRIMARY KEY, started_at TEXT NOT NULL,
      duration_min REAL, kind TEXT, notes TEXT);`);

    initSchema(old, SCHEMA, SEED);

    const columns = new Set(old.all<{ name: string }>('PRAGMA table_info(workout_session)')
      .map((r) => r.name));
    for (const c of ['distance_m', 'avg_hr', 'training_load',
      'aerobic_effect', 'anaerobic_effect']) {
      expect(columns.has(c), `missing column: ${c}`).toBe(true);
    }
  });

  it('keeps the data it already held', () => {
    // An upgrade that silently emptied the log would be far worse than
    // the crash it replaces.
    const old = new NodeDb(':memory:');
    initSchema(old, SCHEMA, SEED);
    old.exec('DROP TABLE body_profile');
    old.run(`INSERT INTO utterance (raw_text, spoken_at, tz_offset_min)
             VALUES (?,?,?)`,
      ['two rotis and rajma', '2026-08-20T13:00:00', 330]);

    initSchema(old, SCHEMA, SEED);

    expect(old.get<{ raw_text: string }>('SELECT raw_text FROM utterance')?.raw_text)
      .toBe('two rotis and rajma');
  });

  it('refreshes a view whose definition has since changed', () => {
    // Views hold no data, so they are dropped and recreated rather than
    // left alone. A stale precedence view would silently return the
    // wrong number, which is worse than an error.
    const old = new NodeDb(':memory:');
    initSchema(old, SCHEMA, SEED);
    old.exec('DROP VIEW v_session_energy');
    old.exec('CREATE VIEW v_session_energy AS SELECT 1 AS wrong');

    initSchema(old, SCHEMA, SEED);

    const sql = old.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE name = 'v_session_energy'")?.sql ?? '';
    expect(sql).not.toContain('wrong');
    expect(sql).toContain('session_energy');
  });
});
