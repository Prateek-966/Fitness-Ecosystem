import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from './helpers';
import type { Db } from '../src/core/db';
import {
  importGarmin, importGarminCsv, parseDuration, parseGarminActivitiesCsv,
  parseGarminDate, parseNumber, parseGarminWellnessCsv, sourceCoverage,
} from '../src/core/garmin';

let db: Db;
beforeEach(() => { db = freshDb(); });

const ACTIVITIES = [
  'Activity Type,Date,Title,Distance,Calories,Time,Avg HR',
  'Running,2026-08-20 06:30:00,Morning Run,8.02,"1,204",00:48:15,152',
  'Cycling,2026-08-21 17:05:00,Evening Ride,24.10,612,01:12:30,131',
  'Strength,2026-08-22 07:00:00,Gym,--,210,00:45:00,--',
].join('\n');

const WELLNESS = [
  'Date,Resting Heart Rate,Total Sleep,REM Sleep,Deep Sleep,Avg Overnight HRV,Average Stress,Steps',
  '2026-08-20,48,7:24,1:32,1:05,62,31,"12,880"',
  '2026-08-21,51,6:10,1:04,0:48,55,44,9210',
  '2026-08-22,--,--,--,--,--,--,--',
].join('\n');

// -----------------------------------------------------------------
// Field parsing. Garmin's exports are messier than they look.
// -----------------------------------------------------------------
describe('field parsing', () => {
  it('reads thousands separators', () => {
    expect(parseNumber('"1,204"'.replace(/"/g, ''))).toBe(1204);
  });

  it('treats Garmin blanks as missing, never as zero', () => {
    // A day the watch spent on the charger is not a zero-step day.
    for (const blank of ['--', '', '-', 'n/a', ' ']) {
      expect(parseNumber(blank)).toBeNull();
      expect(parseDuration(blank)).toBeNull();
    }
  });

  it('reads durations in hours, minutes and seconds', () => {
    expect(parseDuration('1:23:45')).toBeCloseTo(83.75, 6);
    expect(parseDuration('45')).toBe(45);
    expect(parseDuration('7h 24m')).toBe(444);
  });

  it('resolves the two-part ambiguity from the caller, not from the string', () => {
    // Identical text, opposite meanings: 45 min 12 s of activity, or
    // 7 h 24 min of sleep. A sleep figure 60x too small would look
    // entirely plausible to a model.
    expect(parseDuration('45:12', 'minutes_seconds')).toBeCloseTo(45.2, 6);
    expect(parseDuration('7:24', 'hours_minutes')).toBe(444);
  });

  it('reads both date layouts Garmin exports', () => {
    expect(parseGarminDate('2026-08-20 06:30:00')).toEqual({ date: '2026-08-20', time: '06:30:00' });
    expect(parseGarminDate('20/08/2026 6:30 PM')).toEqual({ date: '2026-08-20', time: '18:30:00' });
    expect(parseGarminDate('2026-08-20')).toEqual({ date: '2026-08-20', time: '00:00:00' });
  });

  it('skips a malformed date rather than coercing it onto some day', () => {
    // A wrong timestamp files a workout on the wrong day, and day
    // boundaries are model input.
    for (const bad of ['99/99/2026', 'not a date', '1999-01-01', '2026-13-02']) {
      expect(parseGarminDate(bad)).toBeNull();
    }
  });
});

// -----------------------------------------------------------------
// Activities
// -----------------------------------------------------------------
describe('activity import', () => {
  it('parses sessions with local wall time preserved', () => {
    const { activities } = parseGarminActivitiesCsv(ACTIVITIES);
    expect(activities).toHaveLength(3);
    expect(activities[0]).toMatchObject({
      startedAt: '2026-08-20T06:30:00',
      kind: 'Running',
      kcal: 1204,
      title: 'Morning Run',
    });
    expect(activities[0].durationMin).toBeCloseTo(48.25, 6);
  });

  it('reports columns it did not recognise instead of guessing at them', () => {
    const { unmapped } = parseGarminActivitiesCsv(ACTIVITIES);
    expect(unmapped).toEqual(expect.arrayContaining(['distance', 'avg hr']));
  });

  it('writes one workout_session and one garmin energy row each', () => {
    importGarminCsv(db, ACTIVITIES);
    expect(db.all('SELECT * FROM workout_session')).toHaveLength(3);
    const energy = db.all<{ source: string }>('SELECT source FROM session_energy');
    expect(energy).toHaveLength(3);
    expect(new Set(energy.map((e) => e.source))).toEqual(new Set(['garmin']));
  });

  it('is idempotent - re-importing an overlapping export duplicates nothing', () => {
    importGarminCsv(db, ACTIVITIES);
    const again = importGarminCsv(db, ACTIVITIES);
    expect(again.activitiesInserted).toBe(0);
    expect(db.all('SELECT * FROM workout_session')).toHaveLength(3);
    expect(db.all('SELECT * FROM session_energy')).toHaveLength(3);
  });
});

// -----------------------------------------------------------------
// THE point of the session_energy shape.
// -----------------------------------------------------------------
describe('Garmin energy never merges with another estimator', () => {
  it('keeps a MET estimate and a Garmin figure as separate rows', () => {
    importGarminCsv(db, ACTIVITIES);
    const id = db.get<{ id: number }>(
      "SELECT id FROM workout_session WHERE kind = 'Running'")!.id;
    db.run(
      `INSERT INTO session_energy (session_id, source, kcal, recorded_at)
       VALUES (?, 'met_estimate', 890, '2026-08-20T07:30:00')`, [id]);

    expect(db.all('SELECT * FROM session_energy WHERE session_id = ?', [id])).toHaveLength(2);

    // Both stored. Exactly one summed, and it is not their sum.
    const rows = db.all<{ source: string; kcal: number }>(
      'SELECT source, kcal FROM v_session_energy WHERE session_id = ?', [id]);
    expect(rows).toEqual([{ source: 'garmin', kcal: 1204 }]);
    expect(rows[0].kcal).not.toBe(1204 + 890);
  });

  it('emits exactly one row per session no matter how many sources exist', () => {
    importGarminCsv(db, ACTIVITIES);
    for (const { id } of db.all<{ id: number }>('SELECT id FROM workout_session')) {
      db.run(`INSERT INTO session_energy VALUES (?, 'met_estimate', 500, '2026-08-22T00:00:00')`, [id]);
      db.run(`INSERT INTO session_energy VALUES (?, 'manual', 700, '2026-08-22T00:00:00')`, [id]);
    }
    expect(db.all('SELECT * FROM session_energy')).toHaveLength(9);
    expect(db.all('SELECT * FROM v_session_energy')).toHaveLength(3);
  });

  it('updates the Garmin row in place rather than appending a second one', () => {
    importGarminCsv(db, ACTIVITIES);
    importGarminCsv(db, ACTIVITIES.replace('"1,204"', '1250'));
    const rows = db.all<{ kcal: number }>(
      `SELECT se.kcal FROM session_energy se
       JOIN workout_session ws ON ws.id = se.session_id
       WHERE ws.kind = 'Running' AND se.source = 'garmin'`);
    expect(rows).toEqual([{ kcal: 1250 }]);
  });
});

// -----------------------------------------------------------------
// Daily body metrics
// -----------------------------------------------------------------
describe('wellness import', () => {
  it('maps the metrics the brief actually wants from Garmin', () => {
    const { days } = parseGarminWellnessCsv(WELLNESS);
    expect(days).toHaveLength(2);
    expect(days[0].logDate).toBe('2026-08-20');
    expect(days[0].metrics.rhr_bpm).toBe(48);
    expect(days[0].metrics.hrv_ms).toBe(62);
    expect(days[0].metrics.stress_avg).toBe(31);
    expect(days[0].metrics.steps).toBe(12880);
    expect(days[0].metrics.sleep_min).toBeCloseTo(444, 6);
    expect(days[0].metrics.rem_min).toBeCloseTo(92, 6);
    expect(days[0].metrics.deep_min).toBeCloseTo(65, 6);
  });

  it('does not let "sleep" swallow the "deep sleep" and "rem sleep" columns', () => {
    const { days } = parseGarminWellnessCsv(WELLNESS);
    const m = days[0].metrics;
    expect(new Set([m.sleep_min, m.rem_min, m.deep_min]).size).toBe(3);
  });

  it('drops an all-blank day rather than recording a day of zeroes', () => {
    const { days } = parseGarminWellnessCsv(WELLNESS);
    expect(days.map((d) => d.logDate)).not.toContain('2026-08-22');
  });

  it('stores each metric with its source', () => {
    importGarminCsv(db, WELLNESS);
    const rows = db.all<{ metric: string; source: string; value: number }>(
      "SELECT metric, source, value FROM daily_metric WHERE log_date = '2026-08-20' ORDER BY metric");
    expect(rows.every((r) => r.source === 'garmin')).toBe(true);
    expect(rows.map((r) => r.metric)).toEqual(
      ['deep_min', 'hrv_ms', 'rem_min', 'rhr_bpm', 'sleep_min', 'steps', 'stress_avg']);
  });

  it('is idempotent, and a re-export corrects rather than duplicates', () => {
    importGarminCsv(db, WELLNESS);
    const before = db.all('SELECT * FROM daily_metric').length;
    importGarminCsv(db, WELLNESS.replace(',48,', ',46,'));
    expect(db.all('SELECT * FROM daily_metric')).toHaveLength(before);
    expect(db.get<{ value: number }>(
      "SELECT value FROM daily_metric WHERE log_date='2026-08-20' AND metric='rhr_bpm'")!.value)
      .toBe(46);
  });

  it('resolves one value per metric per day when two sources disagree', () => {
    importGarminCsv(db, WELLNESS);
    db.run(`INSERT INTO daily_metric VALUES ('2026-08-20','rhr_bpm','manual',55,'2026-08-20T09:00:00')`);
    expect(db.all("SELECT * FROM daily_metric WHERE metric='rhr_bpm' AND log_date='2026-08-20'"))
      .toHaveLength(2);
    expect(db.all<{ source: string; value: number }>(
      "SELECT source, value FROM v_daily_metric WHERE metric='rhr_bpm' AND log_date='2026-08-20'"))
      .toEqual([{ source: 'garmin', value: 48 }]);
  });
});

// -----------------------------------------------------------------
// Detection and separation of concerns.
// -----------------------------------------------------------------
describe('one entry point, format detected from headers', () => {
  it('reads an activity export as activities only', () => {
    const r = importGarminCsv(db, ACTIVITIES);
    expect(r.activitiesInserted).toBe(3);
    expect(r.metricRows).toBe(0);
  });

  it('reads a wellness export as days only', () => {
    const r = importGarminCsv(db, WELLNESS);
    expect(r.daysParsed).toBe(2);
    expect(r.activitiesInserted).toBe(0);
    expect(db.all('SELECT * FROM workout_session')).toHaveLength(0);
  });

  it('never writes to the food log', () => {
    importGarminCsv(db, ACTIVITIES);
    importGarminCsv(db, WELLNESS);
    // Garmin describes the body, not the plate. Nothing it supplies is a
    // food entry, and none of it may move an intake total.
    expect(db.all('SELECT * FROM log_entry')).toHaveLength(0);
    expect(db.all('SELECT * FROM utterance')).toHaveLength(0);
    expect(db.all('SELECT * FROM v_daily_totals')).toHaveLength(0);
  });

  it('reports rows it skipped', () => {
    const r = importGarminCsv(db, `${ACTIVITIES}\nRunning,99/99/2026,Broken,1,1,00:01:00,1`);
    expect(r.skipped).toContain('Broken');
    expect(r.activitiesInserted).toBe(3);
  });
});

// -----------------------------------------------------------------
// The step-change boundary, made visible.
// -----------------------------------------------------------------
describe('source coverage', () => {
  it('reports when each source starts and stops', () => {
    importGarminCsv(db, ACTIVITIES);
    importGarminCsv(db, WELLNESS);
    const cov = sourceCoverage(db);

    const rhr = cov.find((c) => c.series === 'rhr_bpm')!;
    expect(rhr).toMatchObject({ source: 'garmin', first_seen: '2026-08-20', last_seen: '2026-08-21' });

    const kcal = cov.find((c) => c.series === 'session_kcal')!;
    expect(kcal).toMatchObject({ source: 'garmin', n: 3 });
  });

  it('separates sources so a regime change is a row, not a discontinuity', () => {
    importGarminCsv(db, WELLNESS);
    db.run(`INSERT INTO daily_metric VALUES ('2026-01-05','rhr_bpm','manual',60,'2026-01-05T08:00:00')`);
    const rhr = sourceCoverage(db).filter((c) => c.series === 'rhr_bpm');
    expect(rhr.map((r) => r.source).sort()).toEqual(['garmin', 'manual']);
    const manualEnds = rhr.find((r) => r.source === 'manual')!.last_seen;
    const garminBegins = rhr.find((r) => r.source === 'garmin')!.first_seen;
    expect(manualEnds < garminBegins).toBe(true);
  });
});

describe('programmatic import', () => {
  it('accepts already-parsed records', () => {
    const r = importGarmin(db, {
      activities: [{
        startedAt: '2026-08-20T06:30:00', kind: 'Running',
        durationMin: 48, kcal: 500, title: null,
      }],
      days: [{ logDate: '2026-08-20', metrics: { rhr_bpm: 48 } }],
    });
    expect(r).toMatchObject({ activitiesInserted: 1, energyRows: 1, metricRows: 1 });
    expect(r.dateRange).toEqual(['2026-08-20', '2026-08-20']);
  });
});
