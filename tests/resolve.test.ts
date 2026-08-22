import { beforeEach, describe, expect, it } from 'vitest';
import { addFood, calibrate, freshDb, indexPhrase, unitId } from './helpers';
import type { Db } from '../src/core/db';
import {
  handleUtterance, recalibrate, resolveSlowPath, revise, toGrams, undoUtterance,
} from '../src/core/resolve';
import { setSetting } from '../src/core/settings';
import { dayTotals } from '../src/core/totals';

let db: Db;
let roti: number;
let rajma: number;

const AT = new Date('2026-08-22T13:00:00.000Z');
const say = (text: string) =>
  handleUtterance(db, { rawText: text, spokenAt: AT, tzOffsetMin: 330, sttConfidence: 0.95 });

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
// Principle 2: capture never blocks.
// -----------------------------------------------------------------
describe('capture never blocks', () => {
  it('persists the raw utterance even when nothing resolves', () => {
    const out = say('some food nobody has ever heard of');
    const row = db.get<{ raw_text: string }>(
      'SELECT raw_text FROM utterance WHERE id = ?', [out.utteranceId],
    );
    expect(row!.raw_text).toBe('some food nobody has ever heard of');
  });

  it('persists the raw utterance even when nothing parses', () => {
    const out = say('...');
    expect(db.get('SELECT 1 FROM utterance WHERE id = ?', [out.utteranceId])).toBeTruthy();
  });

  it('keeps the exact transcript, not the normalised phrase', () => {
    const out = say('Two Rotis!');
    const row = db.get<{ raw_text: string }>(
      'SELECT raw_text FROM utterance WHERE id = ?', [out.utteranceId],
    );
    expect(row!.raw_text).toBe('Two Rotis!');
  });
});

// -----------------------------------------------------------------
// Principle 3: ambiguous never reaches log_entry; incomplete does.
// -----------------------------------------------------------------
describe('ambiguous is not incomplete', () => {
  it('never writes an unknown food to log_entry', () => {
    say('one katori pumpkin flower sabzi');
    expect(db.all('SELECT * FROM log_entry')).toHaveLength(0);
  });

  it('DOES write a known food with no quantity, as pending_quantity', () => {
    const out = say('rajma');
    expect(out.items[0].action).toBe('logged');
    const row = db.get<{ status: string; quantity: number | null; food_id: number }>(
      'SELECT status, quantity, food_id FROM log_entry',
    );
    expect(row).toMatchObject({ status: 'pending_quantity', quantity: null, food_id: rajma });
  });

  it('refuses to let a resolved row be incomplete', () => {
    expect(() =>
      db.run(
        `INSERT INTO log_entry (eaten_at, food_id, status, created_at)
         VALUES (?,?,'resolved',?)`,
        [AT.toISOString(), roti, AT.toISOString()],
      ),
    ).toThrow();
  });
});

// -----------------------------------------------------------------
// Principle 4: pending entries are excluded, never zeroed.
// -----------------------------------------------------------------
describe('pending entries are excluded, never zeroed', () => {
  it('leaves a pending entry out of the total instead of adding zero', () => {
    say('two rotis');
    say('rajma');            // known food, no quantity
    const t = dayTotals(db, '2026-08-22');
    const kcal = t.nutrients.find((n) => n.nutrient === 'kcal')!;

    expect(kcal.total).toBeCloseTo(2 * 45 / 100 * 297, 6);
    expect(kcal.nEntries).toBe(1);
    expect(t.pendingCount).toBe(1);
    expect(t.complete).toBe(false);
  });

  it('says the day is incomplete rather than reporting a confident number', () => {
    say('rajma');
    expect(dayTotals(db, '2026-08-22').complete).toBe(false);
  });
});

// -----------------------------------------------------------------
// Principle 1 / the false-positive asymmetry.
// -----------------------------------------------------------------
describe('match conservatism', () => {
  it('takes the slow path rather than guessing a near miss', () => {
    setSetting(db, 'fuzzy_threshold', 0.95);
    const out = say('one katori rajmah masala');
    expect(out.items[0].action).toBe('slow_path');
    expect(db.all('SELECT * FROM log_entry')).toHaveLength(0);
  });

  it('refuses a fuzzy win that barely beat its runner-up', () => {
    // Two index phrases one character apart. Whichever wins, it wins by
    // almost nothing, and "almost nothing" is a coin flip.
    const a = addFood(db, 'Paneer bhurji', 200);
    const b = addFood(db, 'Paneer burji', 205);
    indexPhrase(db, 'paneer bhurji', a);
    indexPhrase(db, 'paneer burji', b);
    setSetting(db, 'fuzzy_threshold', 0.5);
    setSetting(db, 'min_match_margin', 0.05);

    const out = say('one katori paneer bhurjee');
    expect(out.items[0].action).toBe('slow_path');
  });

  it('records every rejected match for later threshold tuning', () => {
    say('one katori rajmah masala');
    const audit = db.get<{ accepted: number; score: number; threshold: number }>(
      'SELECT accepted, score, threshold FROM match_audit',
    );
    expect(audit!.accepted).toBe(0);
    expect(audit!.score).toBeGreaterThan(0);
    expect(audit!.threshold).toBe(0.82);
  });

  it('logs match_score on every entry from day one', () => {
    say('two rotis');
    const row = db.get<{ match_score: number; match_method: string }>(
      'SELECT match_score, match_method FROM log_entry',
    );
    expect(row!.match_score).toBe(1);
    expect(row!.match_method).toBe('exact_index');
  });
});

// -----------------------------------------------------------------
// Auto-learn gate: log once at the fuzzy threshold, but do not compound.
// -----------------------------------------------------------------
describe('auto-learn is gated above the match threshold', () => {
  it('does not promote a marginal fuzzy hit into a permanent exact match', () => {
    setSetting(db, 'fuzzy_threshold', 0.5);
    setSetting(db, 'min_match_margin', 0.0);
    setSetting(db, 'auto_learn_threshold', 0.99);

    const out = say('one katori rajma masala');
    expect(out.items[0].action).toBe('logged');
    expect(out.items[0].learned).toBe(false);
    expect(db.get('SELECT 1 FROM phrase_index WHERE phrase = ?', ['rajma masala'])).toBeUndefined();
  });

  it('does promote a confident hit', () => {
    setSetting(db, 'auto_learn_threshold', 0.8);
    const out = say('one katori rajmaa');
    expect(out.items[0].learned).toBe(true);
    expect(db.get('SELECT 1 FROM phrase_index WHERE phrase = ?', ['rajmaa'])).toBeTruthy();
  });

  it('makes the second utterance of a learned phrase an exact match', () => {
    setSetting(db, 'auto_learn_threshold', 0.8);
    say('one katori rajmaa');
    const second = say('one katori rajmaa');
    expect(second.items[0].matchMethod).toBe('exact_index');
    expect(second.fastPath).toBe(true);
  });
});

// -----------------------------------------------------------------
// Principle 7: household measures resolve against MY calibration.
// -----------------------------------------------------------------
describe('household measures', () => {
  it('uses the user grams, not a population average', () => {
    say('one katori rajma');
    const row = db.get<{ grams_resolved: number }>('SELECT grams_resolved FROM log_entry');
    expect(row!.grams_resolved).toBe(150);
  });

  it('prefers a food-specific calibration over the general one', () => {
    calibrate(db, 'katori', 210, 'weighed', rajma);
    say('one katori rajma');
    const row = db.get<{ grams_resolved: number }>('SELECT grams_resolved FROM log_entry');
    expect(row!.grams_resolved).toBe(210);
  });

  it('holds the entry pending rather than inventing grams for an uncalibrated unit', () => {
    const chai = addFood(db, 'Chai', 60);
    indexPhrase(db, 'chai', chai);
    const out = say('two glasses chai');
    expect(out.items[0].status).toBe('pending_quantity');
    expect(out.items[0].reason).toBe('unit_uncalibrated');
    expect(toGrams(db, chai, 2, unitId(db, 'glass'))).toBeNull();
  });

  it('passes absolute units straight through', () => {
    const atta = addFood(db, 'Atta', 340);
    indexPhrase(db, 'atta', atta);
    say('60g atta');
    const row = db.get<{ grams_resolved: number }>(
      'SELECT grams_resolved FROM log_entry WHERE food_id = ?', [atta],
    );
    expect(row!.grams_resolved).toBe(60);
  });
});

// -----------------------------------------------------------------
// Principle 6: edits are append-only.
// -----------------------------------------------------------------
describe('edits are append-only', () => {
  it('writes a revision row for every change', () => {
    const out = say('rajma');
    const id = out.items[0].entryId!;
    revise(db, id, 'quantity', 2, 'quantity_supplied');

    const rev = db.get<any>('SELECT * FROM log_revision WHERE log_entry_id = ?', [id]);
    expect(rev).toMatchObject({ field: 'quantity', old_value: null, new_value: '2', reason: 'quantity_supplied' });
  });

  it('completes a pending entry when the quantity arrives', () => {
    const id = say('rajma').items[0].entryId!;
    revise(db, id, 'quantity', 2, 'quantity_supplied');
    const row = db.get<{ status: string; grams_resolved: number }>(
      'SELECT status, grams_resolved FROM log_entry WHERE id = ?', [id],
    );
    expect(row).toMatchObject({ status: 'resolved', grams_resolved: 300 });
  });

  it('un-completes an entry when a revision removes the quantity', () => {
    const id = say('two rotis').items[0].entryId!;
    revise(db, id, 'quantity', null, 'user_edit');
    const row = db.get<{ status: string; grams_resolved: number | null }>(
      'SELECT status, grams_resolved FROM log_entry WHERE id = ?', [id],
    );
    expect(row).toMatchObject({ status: 'pending_quantity', grams_resolved: null });
  });

  it('refuses to revise a column that is not a revisable field', () => {
    const id = say('two rotis').items[0].entryId!;
    expect(() => revise(db, id, 'grams_resolved; DROP TABLE log_entry', 1, 'x')).toThrow();
    expect(db.all('SELECT * FROM log_entry')).toHaveLength(1);
  });

  it('records a revision per entry when a measure is recalibrated', () => {
    say('one katori rajma');
    say('one katori rajma');
    const n = recalibrate(db, unitId(db, 'katori'), null, 165, 'weighed');
    expect(n).toBe(2);

    const revs = db.all<{ old_value: string; new_value: string; reason: string }>(
      "SELECT old_value, new_value, reason FROM log_revision WHERE reason = 'recalibration'",
    );
    expect(revs).toHaveLength(2);
    expect(revs[0]).toMatchObject({ old_value: '150', new_value: '165' });
  });
});

// -----------------------------------------------------------------
// Acceptance criterion 3: zero logs lost.
// -----------------------------------------------------------------
describe('zero logs lost', () => {
  it('leaves an unresolved utterance visibly queued, not marked done', () => {
    const out = say('one katori pumpkin flower sabzi');
    const u = db.get<{ processed_at: string | null }>(
      'SELECT processed_at FROM utterance WHERE id = ?', [out.utteranceId],
    );
    expect(u!.processed_at).toBeNull();
    expect(db.all('SELECT * FROM v_orphan_utterance')).toHaveLength(1);
  });

  it('leaves an unparseable utterance visibly queued', () => {
    say('mmm');
    expect(db.all('SELECT * FROM v_orphan_utterance').length).toBeGreaterThan(0);
  });

  it('does not mark a mixed utterance done while one item is unresolved', () => {
    const out = say('two rotis and one katori pumpkin flower sabzi');
    expect(out.items.map((i) => i.action)).toEqual(['logged', 'slow_path']);
    const u = db.get<{ processed_at: string | null }>(
      'SELECT processed_at FROM utterance WHERE id = ?', [out.utteranceId],
    );
    expect(u!.processed_at).toBeNull();
  });

  it('clears the queue once the slow path is resolved', () => {
    const out = say('one katori pumpkin flower sabzi');
    const sabzi = addFood(db, 'Pumpkin flower sabzi', 90);
    resolveSlowPath(db, {
      utteranceId: out.utteranceId,
      phrase: 'pumpkin flower sabzi',
      foodId: sabzi, quantity: 1, unitId: unitId(db, 'katori'), eatenAt: AT,
    });
    expect(db.all('SELECT * FROM v_orphan_utterance')).toHaveLength(0);
    expect(db.get('SELECT 1 FROM phrase_index WHERE phrase = ?', ['pumpkin flower sabzi'])).toBeTruthy();
  });

  it('makes the same phrase fast forever after', () => {
    const out = say('one katori pumpkin flower sabzi');
    const sabzi = addFood(db, 'Pumpkin flower sabzi', 90);
    resolveSlowPath(db, {
      utteranceId: out.utteranceId, phrase: 'pumpkin flower sabzi',
      foodId: sabzi, quantity: 1, unitId: unitId(db, 'katori'), eatenAt: AT,
    });
    const again = say('one katori pumpkin flower sabzi');
    expect(again.items[0].matchMethod).toBe('exact_index');
    expect(again.complete).toBe(true);
  });
});

// -----------------------------------------------------------------
// Undo replaces the confirm step.
// -----------------------------------------------------------------
describe('undo', () => {
  it('removes the entries but never the utterance', () => {
    const out = say('two rotis');
    expect(undoUtterance(db, out.utteranceId)).toBe(1);
    expect(db.all('SELECT * FROM log_entry')).toHaveLength(0);
    expect(db.get('SELECT 1 FROM utterance WHERE id = ?', [out.utteranceId])).toBeTruthy();
  });

  it('unlearns a phrase the undone utterance had just taught', () => {
    setSetting(db, 'auto_learn_threshold', 0.8);
    const out = say('one katori rajmaa');
    expect(db.get('SELECT 1 FROM phrase_index WHERE phrase = ?', ['rajmaa'])).toBeTruthy();
    undoUtterance(db, out.utteranceId);
    expect(db.get('SELECT 1 FROM phrase_index WHERE phrase = ?', ['rajmaa'])).toBeUndefined();
  });

  it('does not un-learn a phrase that was already known', () => {
    say('two rotis');
    const out = say('two rotis');
    undoUtterance(db, out.utteranceId);
    expect(db.get('SELECT 1 FROM phrase_index WHERE phrase = ?', ['roti'])).toBeTruthy();
  });

  it('keeps an undone utterance out of the lost-logs queue', () => {
    const out = say('two rotis');
    undoUtterance(db, out.utteranceId);
    expect(db.all('SELECT * FROM v_orphan_utterance')).toHaveLength(0);
  });
});

// -----------------------------------------------------------------
// Principle 5: every number carries provenance.
// -----------------------------------------------------------------
describe('provenance', () => {
  it('combines errors in quadrature, not linearly', () => {
    say('two rotis');
    say('one katori rajma');
    const kcal = dayTotals(db, '2026-08-22').nutrients.find((n) => n.nutrient === 'kcal')!;

    const a = 90 / 100 * 297 * 0.2;
    const b = 150 / 100 * 118 * 0.2;
    expect(kcal.absError).toBeCloseTo(Math.sqrt(a * a + b * b), 6);
    expect(kcal.absError).toBeLessThan(a + b);
  });

  it('rejects a nutrient row with no source on its food', () => {
    expect(() =>
      db.run(
        `INSERT INTO food (name, is_composite, created_at) VALUES ('mystery', 0, ?)`,
        [AT.toISOString()],
      ),
    ).toThrow();
  });
});
