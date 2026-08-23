import { beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from './helpers';
import type { Db } from '../src/core/db';
import {
  getSyncToken, hasSyncToken, lastPulledAt, pullFromSync, sanitiseActivities,
  sanitiseDays, setSyncToken, syncStatus, triggerSync,
} from '../src/core/sync';
import { allSettings } from '../src/core/settings';

let db: Db;
beforeEach(() => { db = freshDb(); });

/** A fetch stand-in that records what it was asked for. */
function fakeFetch(handler: (url: string, init?: RequestInit) => {
  status?: number; body?: unknown;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {} } = handler(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const DATA = {
  activities: [{
    startedAt: '2026-08-20T06:30:00', kind: 'running',
    durationMin: 48.25, kcal: 620, title: 'Morning Run',
  }],
  days: [{ logDate: '2026-08-20', metrics: { sleep_min: 445, rhr_bpm: 49, hrv_ms: 61 } }],
};

// -----------------------------------------------------------------
// The token is a credential and is treated like one.
// -----------------------------------------------------------------
describe('the sync token', () => {
  it('round-trips and clears', () => {
    expect(hasSyncToken(db)).toBe(false);
    setSyncToken(db, 'abc123');
    expect(getSyncToken(db)).toBe('abc123');
    setSyncToken(db, null);
    expect(hasSyncToken(db)).toBe(false);
  });

  it('is not stored among the settings the UI renders from', () => {
    // The snapshot the views draw from carries every setting. A bearer
    // token has no business crossing that boundary.
    setSyncToken(db, 'super-secret-token');
    const settings = allSettings(db);
    expect(JSON.stringify(settings)).not.toContain('super-secret-token');
    expect(db.get("SELECT 1 FROM app_setting WHERE value = 'super-secret-token'")).toBeUndefined();
  });

  it('refuses to work without one', async () => {
    await expect(pullFromSync(db)).rejects.toThrow(/No sync token/);
    await expect(triggerSync(db)).rejects.toThrow(/No sync token/);
    expect(await syncStatus(db)).toBeNull();
  });

  it('sends it as a bearer header, to a same-origin path', async () => {
    setSyncToken(db, 'tok');
    const { fn, calls } = fakeFetch(() => ({ body: DATA }));
    await pullFromSync(db, fn);
    expect(calls[0].url.startsWith('/api/')).toBe(true);
    expect((calls[0].init!.headers as any).Authorization).toBe('Bearer tok');
  });

  it('never takes a host from configuration', async () => {
    // Same-origin by construction is what keeps connect-src 'self' intact.
    setSyncToken(db, 'tok');
    const { fn, calls } = fakeFetch(() => ({ body: DATA }));
    await pullFromSync(db, fn);
    await triggerSync(db, fn);
    await syncStatus(db, fn);
    for (const c of calls) expect(c.url).not.toMatch(/^https?:/);
  });
});

// -----------------------------------------------------------------
// Errors are reported, never swallowed.
// -----------------------------------------------------------------
describe('failure reporting', () => {
  it('names a rejected token rather than looking like an empty sync', async () => {
    setSyncToken(db, 'stale');
    const { fn } = fakeFetch(() => ({ status: 401, body: { error: 'unauthorised' } }));
    await expect(pullFromSync(db, fn)).rejects.toThrow(/token rejected/i);
    await expect(syncStatus(db, fn)).rejects.toThrow(/token rejected/i);
  });

  it('passes the server\'s reason through on a failed sync', async () => {
    setSyncToken(db, 'tok');
    const { fn } = fakeFetch(() => ({ status: 502, body: { error: 'Garmin unavailable' } }));
    await expect(triggerSync(db, fn)).rejects.toThrow('Garmin unavailable');
  });
});

// -----------------------------------------------------------------
// The server is ours, but its response is still input.
// -----------------------------------------------------------------
describe('the response is validated before it reaches the database', () => {
  it('drops an activity with no usable start time', () => {
    expect(sanitiseActivities([
      { startedAt: 'yesterday', kcal: 100 },
      { startedAt: 123 },
      null,
      'not an object',
    ])).toEqual([]);
  });

  it('drops NaN and Infinity rather than storing them', () => {
    const [a] = sanitiseActivities([{
      startedAt: '2026-08-20T06:30:00', kcal: NaN, durationMin: Infinity,
    }]);
    expect(a.kcal).toBeNull();
    expect(a.durationMin).toBeNull();
  });

  it('ignores metric keys the schema does not know', () => {
    // A buggy or compromised server must not be able to widen the schema.
    const [d] = sanitiseDays([{
      logDate: '2026-08-20',
      metrics: { rhr_bpm: 49, evil_key: 1, __proto__: 'x', steps: 'lots' },
    }]);
    expect(d.metrics).toEqual({ rhr_bpm: 49 });
  });

  it('drops a day whose date is not a date', () => {
    expect(sanitiseDays([{ logDate: '20/08/2026', metrics: { steps: 1 } }])).toEqual([]);
  });

  it('survives a response that is not the shape it claims', () => {
    expect(sanitiseActivities(null)).toEqual([]);
    expect(sanitiseDays('nope')).toEqual([]);
    expect(sanitiseDays([{ logDate: '2026-08-20' }])).toEqual([]);
  });
});

// -----------------------------------------------------------------
// Everything lands through the SAME import path as a CSV.
// -----------------------------------------------------------------
describe('pulled data goes through the ordinary import', () => {
  beforeEach(() => setSyncToken(db, 'tok'));

  it('writes sessions, a Garmin energy row and daily metrics', async () => {
    const { fn } = fakeFetch(() => ({ body: DATA }));
    const out = await pullFromSync(db, fn);
    expect(out.activities).toBe(1);
    expect(out.metricRows).toBe(3);
    expect(db.all('SELECT * FROM workout_session')).toHaveLength(1);
    expect(db.get<{ source: string }>('SELECT source FROM session_energy')!.source).toBe('garmin');
    expect(db.all('SELECT * FROM daily_metric')).toHaveLength(3);
  });

  it('is idempotent, so overlapping pulls correct rather than duplicate', async () => {
    const { fn } = fakeFetch(() => ({ body: DATA }));
    await pullFromSync(db, fn);
    await pullFromSync(db, fn);
    expect(db.all('SELECT * FROM workout_session')).toHaveLength(1);
    expect(db.all('SELECT * FROM daily_metric')).toHaveLength(3);
  });

  it('overlaps the previous window instead of resuming exactly', async () => {
    // Garmin backfills; the upsert makes redundancy free and a missed
    // revision expensive.
    const { fn, calls } = fakeFetch(() => ({ body: DATA }));
    await pullFromSync(db, fn);
    await pullFromSync(db, fn, 7);
    const since = new URL(`http://x${calls[1].url}`).searchParams.get('since')!;
    const days = Math.round((Date.now() - new Date(`${since}T00:00:00`).getTime()) / 86400000);
    expect(days).toBeGreaterThanOrEqual(7);
  });

  it('never touches the food log', async () => {
    // Garmin describes the body, not the plate.
    const { fn } = fakeFetch(() => ({ body: DATA }));
    await pullFromSync(db, fn);
    expect(db.all('SELECT * FROM log_entry')).toHaveLength(0);
    expect(db.all('SELECT * FROM v_daily_totals')).toHaveLength(0);
  });

  it('keeps Garmin kcal as its own estimate, never merged', async () => {
    const { fn } = fakeFetch(() => ({ body: DATA }));
    await pullFromSync(db, fn);
    const id = db.get<{ id: number }>('SELECT id FROM workout_session')!.id;
    db.run(`INSERT INTO session_energy VALUES (?, 'met_estimate', 500, '2026-08-20T08:00:00')`, [id]);
    expect(db.all('SELECT * FROM session_energy')).toHaveLength(2);
    expect(db.all<{ kcal: number }>('SELECT kcal FROM v_session_energy')).toEqual([{ kcal: 620 }]);
  });

  it('records when it last pulled', async () => {
    const { fn } = fakeFetch(() => ({ body: DATA }));
    expect(lastPulledAt(db)).toBeNull();
    await pullFromSync(db, fn);
    expect(lastPulledAt(db)).not.toBeNull();
  });
});
