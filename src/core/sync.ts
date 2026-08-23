import type { Db } from './db';
import { importGarmin, type GarminActivity, type GarminDay } from './garmin';
import { localDate } from './clock';

/**
 * Pulling Garmin data from the sync server.
 *
 * This is the ONLY outbound request the application makes, it is
 * same-origin, and it exists because auto-pull cannot be done from a
 * browser alone: Garmin needs an OAuth secret and a webhook endpoint, and
 * a page can hold neither.
 *
 * What it deliberately does NOT do is introduce a second way to write
 * data. Everything the server returns goes through the same
 * importGarmin() the CSV path uses, so every guarantee already tested
 * holds identically: idempotent upserts, Garmin's calorie figure kept as
 * its own estimate and never merged, and a missing metric staying missing
 * rather than becoming zero.
 */

const TOKEN_KEY = 'sync_token';
const LAST_KEY = 'sync_last_pulled';

export interface SyncStatus {
  adapter: string;
  running: boolean;
  intervalMin: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  nextSince: string;
  credentialsConfigured: boolean;
}

export interface PullOutcome {
  activities: number;
  metricRows: number;
  since: string;
}

/**
 * The bearer token lives in the database rather than in localStorage.
 *
 * localStorage is readable by any script that ever runs on this origin;
 * OPFS is not. Given a strict CSP that should be a distinction without a
 * difference, but a credential is exactly the wrong thing to protect with
 * only one layer.
 */
export function setSyncToken(db: Db, token: string | null): void {
  if (token === null || token.trim() === '') {
    db.run("DELETE FROM app_secret WHERE key = ?", [TOKEN_KEY]);
    return;
  }
  db.run(
    `INSERT INTO app_secret (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [TOKEN_KEY, token.trim()],
  );
}

export function getSyncToken(db: Db): string | null {
  const row = db.get<{ value: string }>(
    'SELECT value FROM app_secret WHERE key = ?', [TOKEN_KEY]);
  return row?.value ?? null;
}

export function hasSyncToken(db: Db): boolean {
  return getSyncToken(db) !== null;
}

export function lastPulledAt(db: Db): string | null {
  const row = db.get<{ value: string }>(
    'SELECT value FROM app_setting WHERE key = ?', [LAST_KEY]);
  return row?.value ?? null;
}

type Fetcher = typeof fetch;

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

/** Same-origin by construction: no host is ever taken from configuration. */
const API = (path: string) => `/api${path}`;

export async function syncStatus(db: Db, doFetch: Fetcher = fetch): Promise<SyncStatus | null> {
  const token = getSyncToken(db);
  if (!token) return null;
  const res = await doFetch(API('/garmin/status'), { headers: authHeaders(token) });
  if (res.status === 401) throw new Error('Sync token rejected by the server.');
  if (!res.ok) throw new Error(`Sync server returned ${res.status}.`);
  return await res.json() as SyncStatus;
}

/** Ask the server to pull from Garmin now. */
export async function triggerSync(db: Db, doFetch: Fetcher = fetch): Promise<void> {
  const token = getSyncToken(db);
  if (!token) throw new Error('No sync token set.');
  const res = await doFetch(API('/garmin/sync'), { method: 'POST', headers: authHeaders(token) });
  if (res.status === 401) throw new Error('Sync token rejected by the server.');
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Sync failed (${res.status}).`);
  }
}

/**
 * Collect whatever the server is holding and import it.
 *
 * Overlaps the last pull by a week: the server overlaps Garmin for the
 * same reason, and an idempotent upsert makes the overlap free. Being a
 * few days redundant is much cheaper than missing a backfilled night.
 */
export async function pullFromSync(
  db: Db, doFetch: Fetcher = fetch, overlapDays = 7,
): Promise<PullOutcome> {
  const token = getSyncToken(db);
  if (!token) throw new Error('No sync token set.');

  const last = lastPulledAt(db);
  const from = new Date(last ? `${last.slice(0, 10)}T00:00:00` : Date.now() - 28 * 86400_000);
  if (last) from.setDate(from.getDate() - overlapDays);
  const since = localDate(from);

  const res = await doFetch(API(`/garmin/data?since=${since}`), { headers: authHeaders(token) });
  if (res.status === 401) throw new Error('Sync token rejected by the server.');
  if (!res.ok) throw new Error(`Sync server returned ${res.status}.`);

  const body = await res.json() as { activities?: unknown; days?: unknown };
  const activities = sanitiseActivities(body.activities);
  const days = sanitiseDays(body.days);

  const report = importGarmin(db, { activities, days });
  db.run(
    `INSERT INTO app_setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [LAST_KEY, new Date().toISOString()],
  );

  return { activities: report.activitiesInserted, metricRows: report.metricRows, since };
}

const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_KEYS = new Set([
  'sleep_min', 'rem_min', 'deep_min', 'rhr_bpm',
  'hrv_ms', 'stress_avg', 'body_battery_max', 'steps',
]);

/**
 * The server is ours, but its response is still input.
 *
 * A compromised or simply buggy server should not be able to put a NaN
 * into a metric or an unknown key into the schema. Validating here costs
 * nothing and means the database's guarantees do not depend on the
 * server's correctness.
 */
export function sanitiseActivities(raw: unknown): GarminActivity[] {
  if (!Array.isArray(raw)) return [];
  const out: GarminActivity[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (typeof r.startedAt !== 'string' || !ISO_LOCAL.test(r.startedAt)) continue;
    out.push({
      startedAt: r.startedAt,
      kind: typeof r.kind === 'string' ? r.kind : null,
      durationMin: finiteOrNull(r.durationMin),
      kcal: finiteOrNull(r.kcal),
      title: typeof r.title === 'string' ? r.title : null,
    });
  }
  return out;
}

export function sanitiseDays(raw: unknown): GarminDay[] {
  if (!Array.isArray(raw)) return [];
  const out: GarminDay[] = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    if (typeof r.logDate !== 'string' || !ISO_DAY.test(r.logDate)) continue;
    const metrics: GarminDay['metrics'] = {};
    if (r.metrics && typeof r.metrics === 'object') {
      for (const [k, v] of Object.entries(r.metrics as Record<string, unknown>)) {
        if (!METRIC_KEYS.has(k)) continue;
        const n = finiteOrNull(v);
        if (n !== null) (metrics as Record<string, number>)[k] = n;
      }
    }
    if (Object.keys(metrics).length) out.push({ logDate: r.logDate, metrics });
  }
  return out;
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
