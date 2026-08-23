import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { loadConfig, tokenMatches, ConfigError } from '../src/config.ts';
import { SyncStore } from '../src/store.ts';
import { Poller, FIRST_PULL_DAYS, OVERLAP_DAYS, pullEndDate } from '../src/poller.ts';
import { FakeGarmin } from '../src/garmin/fake.ts';
import { createApp } from '../src/index.ts';
import { datesBetween, normaliseActivity, normaliseDay } from '../src/garmin/connect.ts';

const TOKEN = 'test-token-that-is-long-enough-1234';
const DB = '/tmp/claude-0/-home-user-Booking-system/ac804ef8-ff03-5774-8459-cf47a6ec3bf9/scratchpad/sync-test.sqlite3';

let store: SyncStore;
beforeEach(() => {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  store = new SyncStore(DB);
});
afterEach(() => store.close());

// -----------------------------------------------------------------
// Configuration is a security boundary, so it is checked like one.
// -----------------------------------------------------------------
describe('configuration', () => {
  it('refuses to start without a sync token', () => {
    // A public URL serving someone's sleep and heart-rate history to any
    // unauthenticated caller must not be reachable by omission.
    expect(() => loadConfig({ })).toThrow(ConfigError);
    expect(() => loadConfig({ SYNC_TOKEN: '' })).toThrow(/required/);
  });

  it('refuses a short token', () => {
    expect(() => loadConfig({ SYNC_TOKEN: 'short' })).toThrow(/at least 24/);
  });

  it('has no default token to fall back to', () => {
    // Anything generated or defaulted would be a shared secret in a public
    // repository, which is not a secret.
    let thrown = false;
    try { loadConfig({}); } catch { thrown = true; }
    expect(thrown).toBe(true);
  });

  it('treats missing Garmin credentials as "serve the app only", not an error', () => {
    const cfg = loadConfig({ SYNC_TOKEN: TOKEN });
    expect(cfg.garmin).toBeNull();
  });

  it('rejects a poll interval that would hammer Garmin', () => {
    expect(() => loadConfig({ SYNC_TOKEN: TOKEN, SYNC_INTERVAL_MIN: '1' })).toThrow(/>= 15/);
  });

  it('compares tokens without leaking length or position', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
  });
});

// -----------------------------------------------------------------
// The window is a buffer, not a store of record.
// -----------------------------------------------------------------
describe('the sync window', () => {
  const pull = {
    activities: [{ startedAt: '2026-08-20T06:30:00', kind: 'Running', durationMin: 48, kcal: 620, title: 'Run' }],
    days: [{ logDate: '2026-08-20', metrics: { sleep_min: 445, rhr_bpm: 49 } }],
  };

  it('stores and reads back what was pulled', () => {
    store.save(pull);
    const back = store.read('2026-08-01');
    expect(back.activities).toEqual(pull.activities);
    expect(back.days).toEqual(pull.days);
  });

  it('upserts, so an overlapping pull corrects rather than duplicates', () => {
    store.save(pull);
    store.save({
      activities: [{ ...pull.activities[0], kcal: 650 }],
      days: [{ logDate: '2026-08-20', metrics: { sleep_min: 450, rhr_bpm: 49 } }],
    });
    const back = store.read('2026-08-01');
    expect(back.activities).toHaveLength(1);
    expect(back.activities[0].kcal).toBe(650);
    expect(back.days[0].metrics.sleep_min).toBe(450);
  });

  it('filters by date', () => {
    store.save(pull);
    expect(store.read('2026-09-01').activities).toHaveLength(0);
    expect(store.read('2026-09-01').days).toHaveLength(0);
  });

  it('prunes old rows to stay a buffer', () => {
    store.save(pull);
    expect(store.prune('2026-08-25')).toBeGreaterThan(0);
    expect(store.read('2026-01-01').activities).toHaveLength(0);
  });
});

// -----------------------------------------------------------------
// Scheduling, overlap and failure reporting.
// -----------------------------------------------------------------
describe('the poller', () => {
  it('reaches back on a first sync', () => {
    const p = new Poller(new FakeGarmin(), store, 180);
    const expected = new Date();
    expected.setDate(expected.getDate() - FIRST_PULL_DAYS);
    expect(p.nextSince()).toBe(expected.toISOString().slice(0, 10));
  });

  it('overlaps previous windows, because Garmin backfills', async () => {
    // A night's sleep can be revised hours after the fact. Resuming
    // exactly where the last sync stopped would miss those revisions;
    // the upsert makes overlapping free.
    const p = new Poller(new FakeGarmin(), store, 180);
    await p.syncOnce();
    const since = new Date(`${p.nextSince()}T00:00:00Z`);
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    expect(Math.round((today.getTime() - since.getTime()) / 86400000)).toBe(OVERLAP_DAYS);
  });

  it('pulls and stores', async () => {
    const p = new Poller(new FakeGarmin(3), store, 180);
    const r = await p.syncOnce();
    expect(r.ok).toBe(true);
    expect(r.metrics).toBeGreaterThan(0);
    expect(store.read('2000-01-01').days.length).toBe(3);
  });

  it('records a failure instead of failing silently', async () => {
    // A sync that fails quietly is worse than none: you would carry on
    // believing the numbers were fresh.
    const client = new FakeGarmin();
    client.failPullWith = new Error('Garmin said no');
    const p = new Poller(client, store, 180);
    const r = await p.syncOnce();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Garmin said no');
    expect(p.status().lastError).toBe('Garmin said no');
    expect(p.status().lastSuccessAt).toBeNull();
  });

  it('surfaces a login failure with its own message', async () => {
    const client = new FakeGarmin();
    client.failLoginWith = new Error('multi-factor authentication');
    const p = new Poller(client, store, 180);
    expect((await p.syncOnce()).error).toMatch(/multi-factor/);
  });

  it('does not run two syncs at once', async () => {
    const client = new FakeGarmin();
    const p = new Poller(client, store, 180);
    const [a, b] = await Promise.all([p.syncOnce(), p.syncOnce()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(client.pullCalls).toBe(1);
  });

  it('keeps the last good window when a later sync fails', async () => {
    const client = new FakeGarmin(2);
    const p = new Poller(client, store, 180);
    await p.syncOnce();
    const before = store.read('2000-01-01').days.length;
    client.failPullWith = new Error('down');
    await p.syncOnce();
    // Stale data clearly labelled beats no data silently.
    expect(store.read('2000-01-01').days.length).toBe(before);
  });
});

// -----------------------------------------------------------------
// The HTTP surface.
// -----------------------------------------------------------------
describe('the API', () => {
  let base: string;
  let server: ReturnType<typeof createApp>;
  let poller: Poller;

  beforeEach(async () => {
    const cfg = loadConfig({ SYNC_TOKEN: TOKEN, GARMIN_ADAPTER: 'fake', SYNC_DB: DB });
    poller = new Poller(new FakeGarmin(3), store, 180);
    server = createApp(cfg, poller, store);
    await new Promise<void>((ok) => server.listen(0, ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((ok) => server.close(() => ok())));

  const auth = { Authorization: `Bearer ${TOKEN}` };

  it('refuses every data route without a token', async () => {
    for (const path of ['/api/garmin/status', '/api/garmin/data?since=2026-01-01']) {
      expect((await fetch(base + path)).status).toBe(401);
    }
    expect((await fetch(`${base}/api/garmin/sync`, { method: 'POST' })).status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const res = await fetch(`${base}/api/garmin/status`, {
      headers: { Authorization: 'Bearer wrong-token-of-the-same-len-x' },
    });
    expect(res.status).toBe(401);
  });

  it('says nothing about what it holds when unauthorised', async () => {
    const body = await (await fetch(`${base}/api/garmin/status`)).json();
    expect(JSON.stringify(body)).toBe(JSON.stringify({ error: 'unauthorised' }));
  });

  it('answers liveness without auth and without data', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['adapter', 'ok']);
  });

  it('serves status with a token', async () => {
    const res = await fetch(`${base}/api/garmin/status`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ adapter: 'fake', intervalMin: 180 });
  });

  it('syncs on demand and then serves the data', async () => {
    expect((await fetch(`${base}/api/garmin/sync`, { method: 'POST', headers: auth })).status).toBe(200);
    const data = await (await fetch(`${base}/api/garmin/data?since=2000-01-01`, { headers: auth })).json() as any;
    expect(data.days.length).toBe(3);
    expect(data.activities.length).toBeGreaterThan(0);
  });

  it('rejects a malformed since parameter rather than guessing', async () => {
    for (const since of ['yesterday', '2026-13-99x', "' OR 1=1--", '']) {
      const res = await fetch(`${base}/api/garmin/data?since=${encodeURIComponent(since)}`, { headers: auth });
      expect(res.status).toBe(400);
    }
  });

  it('sets the security headers on API responses too', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps connect-src narrow, because the API is same-origin', async () => {
    // The whole reason the API is served from here rather than a second
    // host: no CORS, and nothing to widen in the policy.
    const csp = (await fetch(`${base}/api/health`)).headers.get('content-security-policy')!;
    expect(csp).not.toContain('*');
    expect(csp).toContain("default-src 'self'");
  });

  it('refuses path traversal out of the static root', async () => {
    for (const p of ['/../package.json', '/..%2f..%2fetc%2fpasswd', '/assets/../../src/index.ts']) {
      const res = await fetch(base + p);
      expect([403, 404]).toContain(res.status);
    }
  });

  it('does not rewrite a missing file into the app shell', async () => {
    expect((await fetch(`${base}/no-such-asset.js`)).status).toBe(404);
  });

  it('rejects non-GET on the static surface', async () => {
    expect((await fetch(`${base}/`, { method: 'DELETE' })).status).toBe(405);
  });

  it('reports a failed sync as a gateway error, with the reason', async () => {
    const client = new FakeGarmin();
    client.failPullWith = new Error('Garmin unavailable');
    const cfg = loadConfig({ SYNC_TOKEN: TOKEN, GARMIN_ADAPTER: 'fake', SYNC_DB: DB });
    const bad = createApp(cfg, new Poller(client, store, 180), store);
    await new Promise<void>((ok) => bad.listen(0, ok));
    const url = `http://127.0.0.1:${(bad.address() as AddressInfo).port}/api/garmin/sync`;
    const res = await fetch(url, { method: 'POST', headers: auth });
    expect(res.status).toBe(502);
    expect((await res.json() as any).error).toBe('Garmin unavailable');
    await new Promise<void>((ok) => bad.close(() => ok()));
  });
});

// -----------------------------------------------------------------
// Normalisation of Garmin's own JSON shapes.
// -----------------------------------------------------------------
describe('normalising Garmin JSON', () => {
  it('keeps local wall time on an activity', () => {
    // A UTC conversion here would file an early-morning run on the
    // previous day for anyone east of Greenwich.
    const a = normaliseActivity({
      startTimeLocal: '2026-08-20 06:30:00',
      activityType: { typeKey: 'running' },
      duration: 2895,
      calories: 620,
      activityName: 'Morning Run',
    })!;
    expect(a.startedAt).toBe('2026-08-20T06:30:00');
    expect(a.kind).toBe('running');
    expect(a.durationMin).toBeCloseTo(48.25, 2);
    expect(a.kcal).toBe(620);
  });

  it('drops an activity with no start time rather than inventing one', () => {
    expect(normaliseActivity({ activityName: 'ghost' })).toBeNull();
  });

  it('converts sleep seconds to minutes', () => {
    const d = normaliseDay('2026-08-20', {}, {
      dailySleepDTO: { sleepTimeSeconds: 26700, remSleepSeconds: 5520, deepSleepSeconds: 3900 },
    });
    expect(d.metrics.sleep_min).toBe(445);
    expect(d.metrics.rem_min).toBe(92);
    expect(d.metrics.deep_min).toBe(65);
  });

  it('omits a metric that is absent rather than storing zero', () => {
    // A watch on the charger did not record zero steps.
    const d = normaliseDay('2026-08-20', { totalSteps: null, restingHeartRate: undefined }, null);
    expect(d.metrics).toEqual({});
  });

  it('omits Garmin\'s -1 sentinel for unmeasured stress', () => {
    const d = normaliseDay('2026-08-20', { averageStressLevel: -1 }, null);
    expect(d.metrics.stress_avg).toBeUndefined();
  });

  it('walks a date range and refuses to spin on a bad pair', () => {
    expect(datesBetween('2026-08-20', '2026-08-23')).toEqual(
      ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23']);
    expect(datesBetween('2026-08-23', '2026-08-20')).toEqual([]);
    expect(datesBetween('2000-01-01', '2030-01-01').length).toBeLessThanOrEqual(400);
  });
});

// -----------------------------------------------------------------
// Timezone skew between the server, the host and the user.
// -----------------------------------------------------------------
describe('dates are UTC throughout, not a mix', () => {
  it('overlaps by exactly the stated number of days, in any host zone', async () => {
    // The bug this replaces: parsing a stored date as LOCAL and
    // formatting it back as UTC shifted the window by a day whenever the
    // host ran east of Greenwich.
    const p = new Poller(new FakeGarmin(1), store, 180);
    await p.syncOnce();
    const since = new Date(`${p.nextSince()}T00:00:00Z`);
    const todayUtc = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    expect(Math.round((todayUtc.getTime() - since.getTime()) / 86400000)).toBe(OVERLAP_DAYS);
  });

  it('pulls one day past UTC today, so an eastern user keeps their current day', () => {
    const end = new Date(`${pullEndDate()}T00:00:00Z`);
    const todayUtc = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    expect(Math.round((end.getTime() - todayUtc.getTime()) / 86400000)).toBe(1);
  });
});
