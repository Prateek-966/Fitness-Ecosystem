import { beforeEach, describe, expect, it } from 'vitest';
import { addFood, calibrate, freshDb, indexPhrase } from './helpers';
import type { Db } from '../src/core/db';
import { importHealthify, parseHealthifyCsv, phraseCandidates } from '../src/core/healthify';
import {
  autoRefreshWindows, cluster, deriveWindows, listWindows, refreshWindows, slotFor,
} from '../src/core/mealslot';
import { diagnostics, writeDayStats } from '../src/core/stats';
import { handleUtterance } from '../src/core/resolve';
import { recordTiming } from '../src/core/timing';

let db: Db;
beforeEach(() => { db = freshDb(); });

const CSV = [
  'Date,Time,Meal,Food Name,Portion,Calories,Protein (g),Carbs (g)',
  '22/03/2026,08:15 AM,Breakfast,Poha,1 katori,180,4.2,32',
  '22/03/2026,13:30,Lunch,Rajma,2 katori,340,14,52',
  '22/03/2026,21:00,Dinner,Roti,3 pieces,300,9,60',
  '23/03/2026,08:20 AM,Breakfast,Poha,1 katori,180,4.2,32',
].join('\n');

describe('Healthify import', () => {
  it('imports names, portions and timestamps', () => {
    const { rows } = parseHealthifyCsv(CSV);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      eatenAt: '2026-03-22T08:15:00',
      foodText: 'Poha',
      portionText: '1 katori',
      mealLabel: 'Breakfast',
    });
  });

  it('drops their calorie figures, and says which columns it dropped', () => {
    const { rows, dropped } = parseHealthifyCsv(CSV);
    // Their numbers come from a different food database. Splicing them onto
    // yours is a step change in bias, and a step change in bias is the one
    // thing the TDEE regression cannot cancel.
    for (const r of rows) {
      expect(Object.keys(r)).toEqual(['eatenAt', 'foodText', 'portionText', 'mealLabel']);
    }
    expect(dropped).toEqual(expect.arrayContaining(['calories', 'protein (g)', 'carbs (g)']));

    const report = importHealthify(db, rows, dropped);
    expect(report.inserted).toBe(4);

    const cols = db.all<{ name: string }>("SELECT name FROM pragma_table_info('imported_entry')");
    expect(cols.map((c) => c.name)).not.toContain('kcal');
    expect(cols.map((c) => c.name)).not.toContain('calories');
  });

  it('never turns imported history into log entries', () => {
    const { rows, dropped } = parseHealthifyCsv(CSV);
    importHealthify(db, rows, dropped);
    expect(db.all('SELECT * FROM log_entry')).toHaveLength(0);
  });

  it('is idempotent — re-importing the same export adds nothing', () => {
    const { rows } = parseHealthifyCsv(CSV);
    importHealthify(db, rows);
    const second = importHealthify(db, rows);
    expect(second.inserted).toBe(0);
    expect(second.skippedDuplicate).toBe(4);
  });

  it('handles both dd/mm/yyyy and yyyy-mm-dd exports', () => {
    const iso = 'Date,Time,Food Name,Portion\n2026-03-22,08:15,Poha,1 katori';
    expect(parseHealthifyCsv(iso).rows[0].eatenAt).toBe('2026-03-22T08:15:00');
  });

  it('handles quoted fields containing commas', () => {
    const csv = 'Date,Time,Food Name,Portion\n22/03/2026,08:15,"Dal, tadka",1 katori';
    expect(parseHealthifyCsv(csv).rows[0].foodText).toBe('Dal, tadka');
  });
});

describe('phrase seeding', () => {
  it('ranks the phrases you already say by how often you said them', () => {
    const { rows } = parseHealthifyCsv(CSV);
    importHealthify(db, rows);
    const cands = phraseCandidates(db);
    expect(cands[0]).toMatchObject({ phrase: 'poha', occurrences: 2, suggestedUnit: 'katori' });
  });

  it('offers candidates without binding any of them to a food', () => {
    const { rows } = parseHealthifyCsv(CSV);
    importHealthify(db, rows);
    phraseCandidates(db);
    // Binding a name from someone else's database to a food is a
    // food-identity decision, and those are never made automatically.
    expect(db.all('SELECT * FROM phrase_index')).toHaveLength(0);
  });

  it('marks a candidate already in the index as known', () => {
    const { rows } = parseHealthifyCsv(CSV);
    importHealthify(db, rows);
    indexPhrase(db, 'poha', addFood(db, 'Poha', 130));
    expect(phraseCandidates(db).find((c) => c.phrase === 'poha')!.known).toBe(true);
  });
});

describe('meal slots are derived, not hard-coded', () => {
  it('clusters a bimodal day into two clusters', () => {
    const values = [480, 485, 490, 1260, 1265, 1270];
    expect(cluster(values, 2).map((c) => c.length)).toEqual([3, 3]);
  });

  it('names clusters by time of day, not by how often you log them', () => {
    const stamps: string[] = [];
    // Dinner logged twice as often as breakfast. Breakfast is still first.
    for (const [h, n] of [[8, 3], [13, 4], [17, 3], [21, 8]] as const) {
      for (let i = 0; i < n; i++) stamps.push(`2026-03-2${i % 9}T${String(h).padStart(2, '0')}:${String(10 + i).padStart(2, '0')}:00`);
    }
    const w = deriveWindows(stamps);
    expect(w.map((x) => x.slot)).toEqual(['breakfast', 'lunch', 'snack', 'dinner']);
    expect(w[0].centreMin).toBeLessThan(w[3].centreMin);
  });

  it('names only the slots that exist rather than inventing a fourth', () => {
    const stamps = ['08:10', '08:20', '13:00', '13:10', '21:00', '21:15']
      .map((t) => `2026-03-22T${t}:00`);
    expect(deriveWindows(stamps).map((w) => w.slot)).toEqual(['breakfast', 'lunch', 'dinner']);
  });

  it('is deterministic — same history, same windows', () => {
    const { rows } = parseHealthifyCsv(CSV);
    const stamps = rows.map((r) => r.eatenAt);
    expect(deriveWindows(stamps)).toEqual(deriveWindows(stamps));
  });

  it('derives windows from the import and assigns a slot from them', () => {
    const { rows } = parseHealthifyCsv(CSV);
    importHealthify(db, rows);
    const w = refreshWindows(db, 'imported_entry');
    expect(w.length).toBeGreaterThan(0);
    expect(slotFor(db, new Date('2026-08-22T08:30:00'))).toBe('breakfast');
  });

  it('returns null rather than guessing when nothing has been derived yet', () => {
    expect(slotFor(db, new Date('2026-08-22T08:30:00'))).toBeNull();
  });

  it('treats the day as a circle so a late log is still dinner', () => {
    const { rows } = parseHealthifyCsv(CSV);
    importHealthify(db, rows);
    refreshWindows(db, 'imported_entry');
    expect(slotFor(db, new Date('2026-08-22T23:40:00'))).toBe('dinner');
  });
});

describe('daily_logging_stats', () => {
  beforeEach(() => {
    const roti = addFood(db, 'Roti', 297, { defaultUnit: 'piece' });
    const rajma = addFood(db, 'Rajma', 118, { defaultUnit: 'katori' });
    indexPhrase(db, 'roti', roti, 1, 'piece');
    indexPhrase(db, 'rajma', rajma, 1, 'katori');
    calibrate(db, 'piece', 45);
    calibrate(db, 'katori', 150, 'estimated');
  });

  const say = (t: string) => handleUtterance(db, {
    rawText: t, spokenAt: new Date('2026-08-22T13:00:00.000Z'), tzOffsetMin: 330,
  });

  it('marks a day with any pending entry as ineligible for the model', () => {
    say('two rotis');
    say('rajma');
    const s = writeDayStats(db, '2026-08-22');
    expect(s.pendingCount).toBe(1);
    // Under-logged by a known amount is still under-logged.
    expect(s.modelEligible).toBe(false);
    expect(db.all('SELECT * FROM v_model_excluded_days')).toHaveLength(1);
  });

  it('marks a complete day as eligible', () => {
    say('two rotis');
    expect(writeDayStats(db, '2026-08-22').modelEligible).toBe(true);
  });

  it('marks an empty day as ineligible rather than as a zero-calorie day', () => {
    expect(writeDayStats(db, '2026-08-21').modelEligible).toBe(false);
  });

  it('tracks the fast-path fraction, which is acceptance criterion 2', () => {
    say('two rotis');
    say('one katori rajma');
    expect(writeDayStats(db, '2026-08-22').fastpathFraction).toBe(1);
  });

  it('tracks the weighed fraction so a change of logging regime is visible', () => {
    say('two rotis');          // piece: weighed
    say('one katori rajma');   // katori: estimated
    expect(writeDayStats(db, '2026-08-22').weighedFraction).toBe(0.5);
  });

  it('counts branded foods separately, since eating out changes the regime', () => {
    const burger = addFood(db, 'Burger', 250, { brand: 'Some Chain' });
    indexPhrase(db, 'burger', burger, 1, 'piece');
    say('one burger');
    expect(writeDayStats(db, '2026-08-22').outsideFoodCount).toBe(1);
  });

  it('is idempotent', () => {
    say('two rotis');
    writeDayStats(db, '2026-08-22');
    writeDayStats(db, '2026-08-22');
    expect(db.all('SELECT * FROM daily_logging_stats')).toHaveLength(1);
  });
});

describe('capture timing', () => {
  it('stores a measured total rather than an estimate', () => {
    const roti = addFood(db, 'Roti', 297, { defaultUnit: 'piece' });
    indexPhrase(db, 'roti', roti, 1, 'piece');
    calibrate(db, 'piece', 45);

    const out = handleUtterance(db, {
      rawText: 'two rotis', spokenAt: new Date(), tzOffsetMin: 330,
    });
    const total = recordTiming(db, out.utteranceId, {
      micTap: 1000, sttReturned: 1900, utteranceCommitted: 1930, entriesCommitted: 1950,
    }, true, 1);

    expect(total).toBe(950);
    const d = diagnostics(db);
    expect(d.medianCaptureMs).toBe(950);
    expect(d.underTargetFraction).toBe(1);
    expect(d.lostUtterances).toBe(0);
    expect(d.queuedUtterances).toBe(0);
  });
});

describe('workout energy precedence', () => {
  it('emits exactly one row per session even with three estimates', () => {
    db.run("INSERT INTO workout_session (started_at, kind) VALUES ('2026-08-22T07:00:00','run')");
    for (const [src, kcal] of [['garmin', 412], ['met_estimate', 380], ['manual', 500]] as const) {
      db.run(
        'INSERT INTO session_energy (session_id, source, kcal, recorded_at) VALUES (1,?,?,?)',
        [src, kcal, '2026-08-22T08:00:00'],
      );
    }
    // All three are stored. Only one is ever summed. Double-counting is
    // structurally impossible rather than merely discouraged.
    expect(db.all('SELECT * FROM session_energy')).toHaveLength(3);
    const rows = db.all<{ source: string; kcal: number }>('SELECT source, kcal FROM v_session_energy');
    expect(rows).toEqual([{ source: 'garmin', kcal: 412 }]);
  });

  it('falls back down the precedence order when the preferred source is absent', () => {
    db.run("INSERT INTO workout_session (started_at, kind) VALUES ('2026-08-22T07:00:00','run')");
    db.run("INSERT INTO session_energy VALUES (1,'met_estimate',380,'2026-08-22T08:00:00')");
    db.run("INSERT INTO session_energy VALUES (1,'manual',500,'2026-08-22T08:00:00')");
    expect(db.get<{ source: string }>('SELECT source FROM v_session_energy')!.source).toBe('met_estimate');
  });
});

describe('meal windows derive from whatever record of behaviour exists', () => {
  const spread = (day: string) => [
    `${day}T08:15:00`, `${day}T13:20:00`, `${day}T17:30:00`, `${day}T20:45:00`,
  ];

  it('prefers imported history, because six months beats six days', () => {
    const rows = ['2026-03-20', '2026-03-21', '2026-03-22'].flatMap((d) =>
      spread(d).map((t) => ({ eatenAt: t, foodText: 'Poha', portionText: '1 katori' })));
    importHealthify(db, rows);
    const w = autoRefreshWindows(db);
    expect(w.map((x) => x.slot)).toEqual(['breakfast', 'lunch', 'snack', 'dinner']);
    expect(db.get<{ derived_from: string }>(
      'SELECT derived_from FROM meal_slot_window LIMIT 1')!.derived_from).toBe('imported_entry');
  });

  it('falls back to your own log when there is no import', () => {
    const roti = addFood(db, 'Roti', 297, { defaultUnit: 'piece' });
    indexPhrase(db, 'roti', roti, 1, 'piece');
    calibrate(db, 'piece', 45);
    for (const t of [...spread('2026-08-20'), ...spread('2026-08-21')]) {
      handleUtterance(db, { rawText: 'two rotis', spokenAt: new Date(t), tzOffsetMin: 0 });
    }
    const w = autoRefreshWindows(db);
    expect(w.length).toBeGreaterThan(0);
    expect(db.get<{ derived_from: string }>(
      'SELECT derived_from FROM meal_slot_window LIMIT 1')!.derived_from).toBe('log_entry');
  });

  it('derives nothing from too little data rather than inventing a schedule', () => {
    // Three entries describe a habit no better than a coin describes a
    // distribution. A day that is not yet grouped is honest; groups
    // invented from a default timetable are not.
    importHealthify(db, spread('2026-03-20').slice(0, 3).map((t) => ({
      eatenAt: t, foodText: 'Poha', portionText: null,
    })));
    expect(autoRefreshWindows(db)).toEqual([]);
    expect(listWindows(db)).toEqual([]);
  });

  it('never hard-codes a window: different habits give different centres', () => {
    const early = ['2026-03-20', '2026-03-21'].flatMap((d) =>
      ['06:00', '11:00', '15:00', '18:30'].map((t) => ({
        eatenAt: `${d}T${t}:00`, foodText: 'X', portionText: null })));
    importHealthify(db, early);
    const centres = autoRefreshWindows(db).map((w) => Math.round(w.centreMin));
    expect(centres).toEqual([360, 660, 900, 1110]);
  });
});
