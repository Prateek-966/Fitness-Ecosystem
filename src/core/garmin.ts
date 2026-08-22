import type { Db } from './db';
import { localIso } from './clock';
import { splitCsv } from './csv';

/**
 * Garmin ingestion - from files you export, not from an API.
 *
 * The obstacle is not Garmin's API, it is this application's shape. The
 * app has no server, no account and no secret; every byte of your data
 * lives in your own browser. Garmin's Connect developer programme needs an
 * OAuth client secret and a webhook endpoint to push to, and neither
 * survives contact with a static site: anything shipped to a browser is
 * public, and there is nowhere for a webhook to land. Connecting directly
 * would mean standing up a server that holds a Garmin token and sees your
 * health data in transit - spending the local-first property for a
 * convenience, on data that arrives once a day.
 *
 * So: file in, same as the Healthify and food-database importers. Manual,
 * weekly, and it costs nothing architecturally.
 *
 * WHAT IS WORTH TAKING. The brief wants Garmin for stress, HRV, sleep,
 * REM and resting heart rate - inputs to a future TDEE model. Its calorie
 * figure is the least interesting number it produces, and the most
 * dangerous: it is a DIFFERENT ESTIMATOR from a MET calculation of the
 * same session. It is therefore stored in its own session_energy row and
 * never added to another. v_session_energy emits exactly one row per
 * session, so no SUM can ever pick up two estimates of one workout.
 */

export type MetricKey =
  | 'sleep_min' | 'rem_min' | 'deep_min' | 'rhr_bpm'
  | 'hrv_ms' | 'stress_avg' | 'body_battery_max' | 'steps';

export interface GarminActivity {
  startedAt: string;          // local ISO, no zone suffix
  kind: string | null;
  durationMin: number | null;
  kcal: number | null;
  title: string | null;
}

export interface GarminDay {
  logDate: string;            // YYYY-MM-DD
  metrics: Partial<Record<MetricKey, number>>;
}

export interface GarminReport {
  activitiesParsed: number;
  activitiesInserted: number;
  energyRows: number;
  daysParsed: number;
  metricRows: number;
  skipped: string[];
  unmapped: string[];
  dateRange: [string, string] | null;
}

// ------------------------------------------------------------------
// Column mapping. Garmin's export headers vary by locale, by report and
// by year, so headers are matched loosely - but only against names we
// actually recognise. An unrecognised column is REPORTED, never guessed:
// silently mapping "Calories" onto sleep would be worse than ignoring it.
// ------------------------------------------------------------------
const ACTIVITY_COLUMNS = {
  date: ['date', 'start time', 'activity date'],
  kind: ['activity type', 'activity', 'sport', 'type'],
  title: ['title', 'name', 'activity name'],
  duration: ['elapsed time', 'time', 'duration', 'moving time'],
  kcal: ['calories', 'kcal', 'energy'],
} as const;

const METRIC_COLUMNS: Record<MetricKey, string[]> = {
  sleep_min: ['total sleep', 'sleep duration', 'sleep time', 'sleep'],
  rem_min: ['rem sleep', 'rem'],
  deep_min: ['deep sleep', 'deep'],
  rhr_bpm: ['resting heart rate', 'resting hr', 'rhr'],
  hrv_ms: ['avg overnight hrv', 'heart rate variability', 'hrv'],
  stress_avg: ['average stress', 'avg stress', 'stress level', 'stress'],
  body_battery_max: ['body battery high', 'max body battery', 'body battery'],
  steps: ['total steps', 'steps'],
};

/** Matches exact header first, then substring - never the reverse. */
function findColumn(header: string[], names: readonly string[]): number {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  for (const n of names) {
    const i = header.findIndex((h) => h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Garmin writes numbers with thousands separators, units, and "--" for
 * absent. A blank or "--" is MISSING, never zero: recording zero steps for
 * a day the watch sat on the charger invents a measurement, and inventing
 * measurements is what this whole design exists to avoid.
 */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === '' || t === '--' || t === '-' || t.toLowerCase() === 'n/a') return null;
  const n = Number(t.replace(/,/g, '').replace(/[^\d.eE+-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Colon-separated durations, in minutes.
 *
 * A two-part value is genuinely ambiguous and Garmin exports both
 * readings with identical formatting: "45:12" of elapsed activity time is
 * 45 min 12 s, while "7:24" of sleep is 7 h 24 min. Nothing in the string
 * distinguishes them, so the CALLER states which column it is reading
 * rather than the parser guessing - a sleep figure silently 60x too small
 * would sail straight into the model as a plausible number.
 *
 * Three-part values are always h:mm:ss. A bare number is already minutes.
 * "7h 24m" is accepted too, since some Garmin reports use it.
 */
export function parseDuration(
  raw: string | undefined,
  twoPart: 'minutes_seconds' | 'hours_minutes' = 'minutes_seconds',
): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || t === '--') return null;

  const hm = /^(\d+)\s*h(?:ours?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i.exec(t);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2] ?? 0);

  const parts = t.split(':');
  if (parts.length === 3 || parts.length === 2) {
    const nums = parts.map((p) => Number(p.replace(',', '.')));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    if (parts.length === 3) return nums[0] * 60 + nums[1] + nums[2] / 60;
    return twoPart === 'hours_minutes'
      ? nums[0] * 60 + nums[1]
      : nums[0] + nums[1] / 60;
  }
  return parseNumber(t);
}

/**
 * Garmin exports local wall time, which is exactly what this schema
 * stores. Accepts "2026-08-22 06:30:00", ISO with T, and dd/mm/yyyy.
 * A date that does not validate is SKIPPED, not coerced - a wrong
 * timestamp files a workout on the wrong day, and day boundaries are
 * model input.
 */
export function parseGarminDate(
  raw: string | undefined,
): { date: string; time: string } | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;

  let y: string;
  let mo: string;
  let d: string;
  let rest: string;

  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (ymd) {
    [, y, mo, d] = ymd;
    rest = t.slice(10).trim();
  } else {
    const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(.*)$/.exec(t);
    if (!dmy) return null;
    y = dmy[3];
    mo = dmy[2].padStart(2, '0');
    d = dmy[1].padStart(2, '0');
    rest = dmy[4].trim();
  }

  const mm = Number(mo);
  const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || Number(y) < 2000) return null;

  let time = '00:00:00';
  const hm = /(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*(am|pm)?/i.exec(rest);
  if (hm) {
    let h = Number(hm[1]);
    const ap = hm[4]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23) time = `${String(h).padStart(2, '0')}:${hm[2]}:${hm[3] ?? '00'}`;
  }
  return { date: `${y}-${mo}-${d}`, time };
}

// ------------------------------------------------------------------
// Activities
// ------------------------------------------------------------------
export function parseGarminActivitiesCsv(
  csv: string,
): { activities: GarminActivity[]; unmapped: string[]; skipped: string[] } {
  const rows = splitCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) return { activities: [], unmapped: [], skipped: [] };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {
    date: findColumn(header, ACTIVITY_COLUMNS.date),
    kind: findColumn(header, ACTIVITY_COLUMNS.kind),
    title: findColumn(header, ACTIVITY_COLUMNS.title),
    duration: findColumn(header, ACTIVITY_COLUMNS.duration),
    kcal: findColumn(header, ACTIVITY_COLUMNS.kcal),
  };
  if (idx.date < 0) return { activities: [], unmapped: header, skipped: [] };

  const claimed = new Set(Object.values(idx).filter((i) => i >= 0));
  const unmapped = header.filter((h, i) => !claimed.has(i) && h !== '');

  const activities: GarminActivity[] = [];
  const skipped: string[] = [];
  for (const cells of rows.slice(1)) {
    const when = parseGarminDate(cells[idx.date]);
    if (!when) {
      const label = (idx.title >= 0 ? cells[idx.title] : cells[idx.date]) ?? '';
      if (label.trim()) skipped.push(label.trim());
      continue;
    }
    activities.push({
      startedAt: `${when.date}T${when.time}`,
      kind: idx.kind >= 0 ? (cells[idx.kind]?.trim() || null) : null,
      durationMin: idx.duration >= 0 ? parseDuration(cells[idx.duration]) : null,
      kcal: idx.kcal >= 0 ? parseNumber(cells[idx.kcal]) : null,
      title: idx.title >= 0 ? (cells[idx.title]?.trim() || null) : null,
    });
  }
  return { activities, unmapped, skipped };
}

// ------------------------------------------------------------------
// Daily wellness
// ------------------------------------------------------------------
export function parseGarminWellnessCsv(
  csv: string,
): { days: GarminDay[]; unmapped: string[]; skipped: string[] } {
  const rows = splitCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length < 2) return { days: [], unmapped: [], skipped: [] };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const iDate = findColumn(header, ACTIVITY_COLUMNS.date);
  if (iDate < 0) return { days: [], unmapped: header, skipped: [] };

  // Longest alias first, so "deep sleep" is not swallowed by "sleep" and
  // a column already claimed cannot be claimed twice.
  const claimed = new Set<number>([iDate]);
  const metricCols: Array<[number, MetricKey]> = [];
  const byAliasLength = (Object.entries(METRIC_COLUMNS) as Array<[MetricKey, string[]]>)
    .sort((a, b) =>
      Math.max(...b[1].map((s) => s.length)) - Math.max(...a[1].map((s) => s.length)));

  for (const [key, aliases] of byAliasLength) {
    const masked = header.map((h, j) => (claimed.has(j) ? '' : h));
    const i = findColumn(masked, aliases);
    if (i >= 0) {
      metricCols.push([i, key]);
      claimed.add(i);
    }
  }
  const unmapped = header.filter((h, i) => !claimed.has(i) && h !== '');

  const days: GarminDay[] = [];
  const skipped: string[] = [];
  for (const cells of rows.slice(1)) {
    const when = parseGarminDate(cells[iDate]);
    if (!when) {
      if ((cells[iDate] ?? '').trim()) skipped.push(cells[iDate].trim());
      continue;
    }
    const metrics: Partial<Record<MetricKey, number>> = {};
    for (const [i, key] of metricCols) {
      // Sleep durations read as hours:minutes; everything else is a
      // scalar. See parseDuration on why this is stated, not inferred.
      const v = key.endsWith('_min')
        ? parseDuration(cells[i], 'hours_minutes')
        : parseNumber(cells[i]);
      if (v !== null) metrics[key] = v;
    }
    if (Object.keys(metrics).length) days.push({ logDate: when.date, metrics });
  }
  return { days, unmapped, skipped };
}

// ------------------------------------------------------------------
// Writing
// ------------------------------------------------------------------
export function importGarmin(
  db: Db,
  input: {
    activities?: GarminActivity[];
    days?: GarminDay[];
    unmapped?: string[];
    skipped?: string[];
  },
): GarminReport {
  const activities = input.activities ?? [];
  const days = input.days ?? [];
  const now = localIso();
  let activitiesInserted = 0;
  let energyRows = 0;
  let metricRows = 0;

  db.tx(() => {
    for (const a of activities) {
      // Idempotent on (started_at, kind): re-importing an overlapping
      // export updates rather than duplicating.
      const existing = db.get<{ id: number }>(
        `SELECT id FROM workout_session
         WHERE started_at = ? AND COALESCE(kind, '') = COALESCE(?, '')`,
        [a.startedAt, a.kind],
      );
      let sessionId: number;
      if (existing) {
        sessionId = existing.id;
        db.run('UPDATE workout_session SET duration_min = ?, notes = ? WHERE id = ?',
               [a.durationMin, a.title, sessionId]);
      } else {
        sessionId = db.run(
          `INSERT INTO workout_session (started_at, duration_min, kind, notes)
           VALUES (?,?,?,?)`,
          [a.startedAt, a.durationMin, a.kind, a.title],
        ).lastInsertRowid;
        activitiesInserted++;
      }

      if (a.kcal !== null) {
        // Its OWN row. Never merged with, added to, or preferred over a
        // MET estimate at write time - v_session_energy decides that on
        // read, and emits exactly one row per session either way.
        db.run(
          `INSERT INTO session_energy (session_id, source, kcal, recorded_at)
           VALUES (?, 'garmin', ?, ?)
           ON CONFLICT(session_id, source) DO UPDATE SET
             kcal = excluded.kcal, recorded_at = excluded.recorded_at`,
          [sessionId, a.kcal, now],
        );
        energyRows++;
      }
    }

    for (const d of days) {
      for (const [metric, value] of Object.entries(d.metrics)) {
        db.run(
          `INSERT INTO daily_metric (log_date, metric, source, value, recorded_at)
           VALUES (?, ?, 'garmin', ?, ?)
           ON CONFLICT(log_date, metric, source) DO UPDATE SET
             value = excluded.value, recorded_at = excluded.recorded_at`,
          [d.logDate, metric, value as number, now],
        );
        metricRows++;
      }
    }
  });

  const range = db.get<{ lo: string | null; hi: string | null }>(
    `SELECT MIN(d) AS lo, MAX(d) AS hi FROM (
       SELECT log_date AS d FROM daily_metric
       UNION ALL SELECT date(started_at) FROM workout_session)`,
  );

  return {
    activitiesParsed: activities.length,
    activitiesInserted,
    energyRows,
    daysParsed: days.length,
    metricRows,
    skipped: input.skipped ?? [],
    unmapped: input.unmapped ?? [],
    dateRange: range?.lo ? [range.lo, range.hi as string] : null,
  };
}

/**
 * One entry point for "here is a Garmin CSV" - which export you happen to
 * have is detected from its headers rather than by asking you to say. A
 * file that is both (dates plus activity and wellness columns) is read as
 * both.
 */
export function importGarminCsv(db: Db, csv: string): GarminReport {
  const act = parseGarminActivitiesCsv(csv);
  const wel = parseGarminWellnessCsv(csv);
  const hasActivities = act.activities.some(
    (a) => a.kcal !== null || a.durationMin !== null || a.kind !== null);
  const hasWellness = wel.days.length > 0;

  return importGarmin(db, {
    activities: hasActivities ? act.activities : [],
    days: hasWellness ? wel.days : [],
    // Report unmapped columns from whichever reading actually applied.
    unmapped: hasWellness && !hasActivities ? wel.unmapped : act.unmapped,
    skipped: [...new Set([...act.skipped, ...wel.skipped])],
  });
}

export interface SourceCoverage {
  relation: string;
  series: string;
  source: string;
  first_seen: string;
  last_seen: string;
  n: number;
}

/** When each source started - the step-change boundary, made visible. */
export function sourceCoverage(db: Db): SourceCoverage[] {
  return db.all<SourceCoverage>(
    'SELECT * FROM v_source_coverage ORDER BY relation, series, source',
  );
}
