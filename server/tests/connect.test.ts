import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectGarmin, normaliseActivity, normaliseDay } from '../src/garmin/connect.ts';

/**
 * The Connect login has never run against live Garmin - this project has
 * no outbound network access. What CAN be pinned is the shape of the
 * flow, and the shape is where the previous version was wrong: it
 * scraped an HTML form for a CSRF token, skipped the OAuth1 leg
 * entirely, and left the profile name out of the daily URLs. Each of
 * those is now a test, so the same mistakes cannot come back quietly.
 */

interface Call { method: string; url: string; headers: Record<string, string>; body?: string }

let calls: Call[];
let realFetch: typeof globalThis.fetch;

/** Enough of a Response for this adapter, including getSetCookie. */
function reply(body: unknown, status = 200, setCookie: string[] = []): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status < 400,
    headers: { getSetCookie: () => setCookie },
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

const ROUTES: Array<[RegExp, () => Response]> = [
  [/sso\/mobile\/sso\/en\/sign-in/, () => reply('<html/>', 200, ['GARMIN-SSO=abc; Path=/'])],
  [/sso\/mobile\/api\/login/, () =>
    reply({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-0-xyz' })],
  [/oauth-service\/oauth\/preauthorized/, () =>
    reply('oauth_token=OA1TOKEN&oauth_token_secret=OA1SECRET')],
  [/oauth-service\/oauth\/exchange/, () =>
    reply({ access_token: 'BEARER-123', expires_in: 3600 })],
  [/userprofile-service\/socialProfile/, () => reply({ displayName: 'user.name' })],
  [/activitylist-service/, () => reply([])],
  [/hrv-service/, () => reply({ hrvSummaries: [] })],
  [/usersummary-service/, () => reply({ totalSteps: 8000 })],
  [/wellness-service/, () => reply({ dailySleepDTO: { sleepTimeSeconds: 26700 } })],
];

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      method: init.method ?? 'GET',
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    for (const [pattern, make] of ROUTES) if (pattern.test(String(url))) return make();
    throw new Error(`unrouted request: ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

const called = (pattern: RegExp) => calls.filter((c) => pattern.test(c.url));

describe('the login flow', () => {
  it('uses the JSON login endpoint, not the retired HTML form', async () => {
    await new ConnectGarmin('a@b.com', 'pw').login();
    const login = called(/mobile\/api\/login/)[0];
    expect(login).toBeDefined();
    expect(login.method).toBe('POST');
    expect(login.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(login.body!)).toMatchObject({ username: 'a@b.com', password: 'pw' });
  });

  it('completes both OAuth legs, each with a signature', async () => {
    // Ticket -> OAuth1 -> OAuth2. Skipping the middle leg was the single
    // largest defect in the previous version; it cannot work.
    await new ConnectGarmin('a@b.com', 'pw').login();
    const pre = called(/preauthorized/)[0];
    const exch = called(/exchange\/user\/2\.0/)[0];
    expect(pre).toBeDefined();
    expect(exch).toBeDefined();
    for (const c of [pre, exch]) {
      expect(c.headers.Authorization).toMatch(/^OAuth /);
      expect(c.headers.Authorization).toContain('oauth_signature="');
      expect(c.headers.Authorization).toContain('oauth_signature_method="HMAC-SHA1"');
    }
    // The second leg presents the token the first one returned.
    expect(exch.headers.Authorization).toContain('oauth_token="OA1TOKEN"');
  });

  it('carries the service ticket into the OAuth1 request', async () => {
    await new ConnectGarmin('a@b.com', 'pw').login();
    expect(called(/preauthorized/)[0].url).toContain('ticket=ST-0-xyz');
  });

  it('never puts the password in a URL', async () => {
    // A query string ends up in proxy logs and error reports; a JSON
    // body over TLS does not.
    await new ConnectGarmin('a@b.com', 'hunter2').login();
    for (const c of calls) expect(c.url).not.toContain('hunter2');
  });

  it('refuses an MFA account with a message that says what to do', async () => {
    ROUTES[1] = [/sso\/mobile\/api\/login/, () =>
      reply({ responseStatus: { type: 'MFA_REQUIRED' }, customerMfaInfo: {} })];
    await expect(new ConnectGarmin('a@b.com', 'pw').login())
      .rejects.toThrow(/multi-factor authentication/);
    ROUTES[1] = [/sso\/mobile\/api\/login/, () =>
      reply({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-0-xyz' })];
  });

  it('reports what Garmin said when it rejects the credentials', async () => {
    ROUTES[1] = [/sso\/mobile\/api\/login/, () =>
      reply({ responseStatus: { type: 'INVALID_CREDENTIALS', message: 'bad password' } })];
    await expect(new ConnectGarmin('a@b.com', 'pw').login())
      .rejects.toThrow(/bad password/);
    ROUTES[1] = [/sso\/mobile\/api\/login/, () =>
      reply({ responseStatus: { type: 'SUCCESSFUL' }, serviceTicketId: 'ST-0-xyz' })];
  });
});

describe('token persistence', () => {
  const store = () => {
    const kv = new Map<string, string>();
    return {
      kv,
      get: (k: string) => kv.get(k) ?? null,
      set: (k: string, v: string) => { kv.set(k, v); },
    };
  };

  it('keeps the OAuth1 token, which Garmin issues for about a year', async () => {
    const s = store();
    await new ConnectGarmin('a@b.com', 'pw', s).login();
    expect(JSON.parse(s.kv.get('garmin_oauth1')!)).toMatchObject({ token: 'OA1TOKEN' });
  });

  it('an expired bearer is renewed from the stored OAuth1 token', async () => {
    // Every restart costing a password login is how an account gets
    // rate-limited by its own owner.
    const s = store();
    await new ConnectGarmin('a@b.com', 'pw', s).login();
    // Only the short-lived half expires; the OAuth1 token is untouched.
    s.kv.set('garmin_oauth2', JSON.stringify({ bearer: 'old', expiresAt: Date.now() - 1 }));

    calls = [];
    await new ConnectGarmin('a@b.com', 'pw', s).login();
    expect(called(/mobile\/api\/login/)).toHaveLength(0);
    expect(called(/exchange\/user\/2\.0/)).toHaveLength(1);
  });

  it('a restart with a live bearer makes no requests at all', async () => {
    const s = store();
    await new ConnectGarmin('a@b.com', 'pw', s).login();
    calls = [];
    await new ConnectGarmin('a@b.com', 'pw', s).login();
    expect(calls).toHaveLength(0);
  });

  it('a live bearer costs no requests at all', async () => {
    const s = store();
    const client = new ConnectGarmin('a@b.com', 'pw', s);
    await client.login();
    calls = [];
    await client.login();
    expect(calls).toHaveLength(0);
  });

  it('takes the expiry from Garmin rather than guessing an interval', async () => {
    const s = store();
    await new ConnectGarmin('a@b.com', 'pw', s).login();
    const held = JSON.parse(s.kv.get('garmin_oauth2')!);
    // 3600s from the stub, not the three hours the old version assumed.
    expect(held.expiresAt - Date.now()).toBeGreaterThan(3500_000);
    expect(held.expiresAt - Date.now()).toBeLessThanOrEqual(3600_000);
  });
});

describe('the pull', () => {
  it('puts the profile display name in the daily URLs', async () => {
    // Omitting it does not 404. It 403s, which reads like an auth
    // failure and sends you debugging the wrong thing entirely.
    const client = new ConnectGarmin('a@b.com', 'pw');
    await client.login();
    await client.pull(new Date().toISOString().slice(0, 10));
    expect(called(/usersummary-service/)[0].url).toContain('/daily/user.name?');
    expect(called(/dailySleepData/)[0].url).toContain('/dailySleepData/user.name?');
  });

  it('fetches HRV once for the window, not once per day', async () => {
    const client = new ConnectGarmin('a@b.com', 'pw');
    await client.login();
    await client.pull('2026-08-01');
    expect(called(/hrv-service/)).toHaveLength(1);
  });

  it('presents the bearer, not the OAuth1 token, on data requests', async () => {
    const client = new ConnectGarmin('a@b.com', 'pw');
    await client.login();
    await client.pull(new Date().toISOString().slice(0, 10));
    expect(called(/activitylist-service/)[0].headers.Authorization).toBe('Bearer BEARER-123');
  });
});

describe('normalising what comes back', () => {
  it('keeps local wall time, so an early run stays on its own day', () => {
    const a = normaliseActivity({
      startTimeLocal: '2026-08-20 06:30:00', activityType: { typeKey: 'running' },
      duration: 2880, calories: 620, activityName: 'Morning run',
    });
    expect(a?.startedAt).toBe('2026-08-20T06:30:00');
    expect(a?.durationMin).toBe(48);
  });

  it('carries distance, heart rate and training load through', () => {
    const a = normaliseActivity({
      startTimeLocal: '2026-08-20 06:30:00', distance: 8213.7, averageHR: 152.4,
      activityTrainingLoad: 141, aerobicTrainingEffect: 3.4, anaerobicTrainingEffect: 0.6,
    });
    expect(a).toMatchObject({
      distanceM: 8214, avgHr: 152, trainingLoad: 141,
      aerobicEffect: 3.4, anaerobicEffect: 0.6,
    });
  });

  it('drops a measurement rather than inventing one', () => {
    const day = normaliseDay('2026-08-20', { totalSteps: null, restingHeartRate: 49 }, null);
    expect(day.metrics).toEqual({ rhr_bpm: 49 });
    expect('steps' in day.metrics).toBe(false);
  });

  it('treats Garmin’s -1 for stress as no reading, not as a value', () => {
    // -1 minutes of stress is worse than no reading at all.
    const day = normaliseDay('2026-08-20',
      { averageStressLevel: -1, maxStressLevel: -1, restingHeartRate: 49 }, null);
    expect('stress_avg' in day.metrics).toBe(false);
    expect('stress_max' in day.metrics).toBe(false);
  });

  it('prefers the HRV range endpoint over the value buried in sleep', () => {
    const day = normaliseDay('2026-08-20', {},
      { dailySleepDTO: { avgOvernightHrv: 30 } }, 42);
    expect(day.metrics.hrv_ms).toBe(42);
  });

  it('falls back to the sleep payload for days the range did not cover', () => {
    const day = normaliseDay('2026-08-20', {},
      { dailySleepDTO: { avgOvernightHrv: 30 } }, undefined);
    expect(day.metrics.hrv_ms).toBe(30);
  });

  it('reads the fuller sleep breakdown', () => {
    const day = normaliseDay('2026-08-20', {}, {
      dailySleepDTO: {
        sleepTimeSeconds: 26700, remSleepSeconds: 5400, deepSleepSeconds: 4200,
        lightSleepSeconds: 15300, awakeSleepSeconds: 900,
        sleepScores: { overall: { value: 82 } },
      },
    });
    expect(day.metrics).toMatchObject({
      sleep_min: 445, rem_min: 90, deep_min: 70, light_min: 255,
      awake_min: 15, sleep_score: 82,
    });
  });
});
