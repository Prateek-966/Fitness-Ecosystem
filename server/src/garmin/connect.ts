import type { GarminActivity, GarminClient, GarminDay, GarminPull } from './client.ts';
import { isUsable, secondsToMinutes } from './client.ts';
import { authHeader, type Consumer, type Token } from './oauth1.ts';
import { pullEndDate } from '../poller.ts';

/**
 * Garmin Connect adapter.
 *
 * WHAT THIS IS, HONESTLY. Garmin's official Health API is a partner
 * programme: it requires application and approval, is not self-serve, and
 * is not obtainable for a personal project on demand. This adapter
 * therefore uses the same route every self-hosted Garmin project uses -
 * the Connect mobile SSO, signing in as you with your own credentials.
 *
 * The consequences, stated rather than buried:
 *  - It is UNDOCUMENTED and unversioned. Garmin can change it without
 *    notice, and periodically does. When it breaks, this file is what is
 *    wrong; everything around it keeps working, which is why it is
 *    isolated behind a two-method interface.
 *  - It stores a session for your account. Run this only on
 *    infrastructure you control.
 *  - Multi-factor authentication is detected and refused with a clear
 *    message rather than a confusing one. The account this was built for
 *    does not use it; supporting it needs an interactive code prompt,
 *    which is a UI change, not a change here.
 *
 * THE FLOW, which is the part that is easy to get wrong:
 *
 *   1. GET  /sso/mobile/sso/en/sign-in    - collect cookies
 *   2. POST /sso/mobile/api/login         - JSON, returns a service ticket
 *   3. GET  /oauth-service/oauth/preauthorized  - OAuth1-SIGNED, gives an
 *                                           OAuth1 token good for ~a year
 *   4. POST /oauth-service/oauth/exchange/user/2.0 - OAuth1-SIGNED, gives
 *                                           the OAuth2 bearer everything
 *                                           else uses
 *   5. GET  /userprofile-service/socialProfile - the displayName that the
 *                                           daily endpoints need in their
 *                                           PATH, not as a parameter
 *
 * An earlier version of this file scraped an HTML form for a `_csrf`
 * token (Garmin has since moved to the JSON API in step 2), went straight
 * from ticket to bearer with no OAuth1 leg at all (steps 3 and 4 cannot
 * be skipped), and omitted the displayName in step 5, which alone would
 * have made every daily request 403. All three are corrected here.
 */

const SSO = 'https://sso.garmin.com/sso';
const CONNECT_API = 'https://connectapi.garmin.com';
const CLIENT_ID = 'GCM_ANDROID_DARK';
const SERVICE_URL = 'https://mobile.integration.garmin.com/gcm/android';

/**
 * The OAuth1 consumer credential, pinned.
 *
 * Every open-source Garmin client fetches this from a third-party S3
 * bucket at login. That means someone outside both you and Garmin
 * supplies the key that signs requests against your account, and can
 * change it whenever they like. Pinning it removes that party from the
 * normal path; the fetch is kept only as a fallback for the day Garmin
 * rotates the value, so this self-heals without trusting the bucket
 * routinely.
 */
const PINNED_CONSUMER: Consumer = {
  key: 'fc3e99d2-118c-44b8-8ae3-03370dde24c0',
  secret: 'E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF',
};
const CONSUMER_FALLBACK_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';

/** The SSO endpoints run in a WebView and reject non-browser clients. */
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** The OAuth endpoints want the Android app, and check. */
const OAUTH_UA = { 'User-Agent': 'com.garmin.android.apps.connectmobile' };

export class GarminAuthError extends Error {
  constructor(step: string, detail: string) {
    super(`Garmin login failed at ${step}: ${detail}`);
  }
}

export class GarminPullError extends Error {
  constructor(what: string, detail: string) {
    super(`Garmin pull failed fetching ${what}: ${detail}`);
  }
}

/**
 * Somewhere to keep tokens across restarts. Deliberately the shape of
 * two methods rather than the store class, so this file does not depend
 * on how the server persists anything.
 */
export interface TokenStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

interface StoredOauth1 { token: string; secret: string; obtainedAt: number; mfaToken?: string; }
interface StoredOauth2 { bearer: string; expiresAt: number; }

/** Garmin's OAuth1 tokens last about a year; refuse to trust one longer. */
const OAUTH1_MAX_AGE_MS = 300 * 24 * 3600_000;

export class ConnectGarmin implements GarminClient {
  readonly name = 'connect';

  // Explicit fields: see the note in poller.ts - strip-only mode cannot
  // synthesise constructor parameter properties.
  private email: string;
  private password: string;
  private tokens: TokenStore | null;
  private consumer: Consumer = PINNED_CONSUMER;

  private oauth1: StoredOauth1 | null = null;
  private oauth2: StoredOauth2 | null = null;
  private displayName: string | null = null;

  constructor(email: string, password: string, tokens: TokenStore | null = null) {
    this.email = email;
    this.password = password;
    this.tokens = tokens;
    this.oauth1 = this.load<StoredOauth1>('garmin_oauth1');
    this.oauth2 = this.load<StoredOauth2>('garmin_oauth2');
  }

  private load<T>(key: string): T | null {
    const raw = this.tokens?.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  }

  private save(key: string, value: unknown): void {
    this.tokens?.set(key, JSON.stringify(value));
  }

  // ---------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------

  /**
   * Three ways in, cheapest first. A restart should not cost a password
   * round-trip, and hammering Garmin's SSO is how accounts get blocked.
   */
  async login(): Promise<void> {
    // A minute of headroom: a token that expires mid-pull is a 401 that
    // looks like a broken session.
    if (this.oauth2 && this.oauth2.expiresAt > Date.now() + 60_000) return;

    if (this.oauth1 && Date.now() - this.oauth1.obtainedAt < OAUTH1_MAX_AGE_MS) {
      try {
        await this.exchange();
        return;
      } catch {
        // Expired or revoked at Garmin's end. Fall through to a full
        // login rather than failing the sync.
        this.oauth1 = null;
      }
    }

    const ticket = await this.serviceTicket();
    await this.preauthorize(ticket);
    await this.exchange();
  }

  /** Steps 1 and 2: cookies, then credentials, then a one-time ticket. */
  private async serviceTicket(): Promise<string> {
    const cookies = new Map<string, string>();

    const signIn = await this.step('sign-in page',
      `${SSO}/mobile/sso/en/sign-in?clientId=${CLIENT_ID}`,
      { headers: { ...PAGE_HEADERS, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' } });
    absorbCookies(signIn, cookies);

    const query = new URLSearchParams({
      clientId: CLIENT_ID, locale: 'en-US', service: SERVICE_URL,
    });
    const res = await this.step('credentials', `${SSO}/mobile/api/login?${query}`, {
      method: 'POST',
      headers: {
        ...PAGE_HEADERS,
        'Content-Type': 'application/json',
        Cookie: cookieHeader(cookies),
      },
      body: JSON.stringify({
        username: this.email, password: this.password,
        rememberMe: false, captchaToken: '',
      }),
    });

    const body = await res.json().catch(() => null) as {
      responseStatus?: { type?: string; message?: string };
      serviceTicketId?: string;
    } | null;

    const type = body?.responseStatus?.type;
    if (type === 'MFA_REQUIRED') {
      throw new GarminAuthError('credentials',
        'this account requires multi-factor authentication, which this adapter does not '
        + 'support. Turn MFA off for the account, or keep using CSV import.');
    }
    if (type !== 'SUCCESSFUL' || !body?.serviceTicketId) {
      throw new GarminAuthError('credentials',
        body?.responseStatus?.message
          ? `Garmin said: ${body.responseStatus.message}`
          : `unexpected response status '${type ?? 'none'}' and no service ticket`);
    }
    return body.serviceTicketId;
  }

  /** Step 3: the ticket buys a long-lived OAuth1 token. Signed. */
  private async preauthorize(ticket: string): Promise<void> {
    const url = `${CONNECT_API}/oauth-service/oauth/preauthorized`;
    const params = {
      ticket, 'login-url': SERVICE_URL, 'accepts-mfa-tokens': 'true',
    };
    const res = await this.step('oauth1 preauthorize',
      `${url}?${new URLSearchParams(params)}`,
      { headers: { ...OAUTH_UA, Authorization: authHeader('GET', url, params, this.consumer) } });

    // Form-encoded, not JSON.
    const parsed = new URLSearchParams(await res.text());
    const token = parsed.get('oauth_token');
    const secret = parsed.get('oauth_token_secret');
    if (!token || !secret) {
      throw new GarminAuthError('oauth1 preauthorize',
        'no oauth_token in the response - the consumer credential may have been rotated');
    }
    this.oauth1 = {
      token, secret, obtainedAt: Date.now(),
      mfaToken: parsed.get('mfa_token') ?? undefined,
    };
    this.save('garmin_oauth1', this.oauth1);
  }

  /** Step 4: the OAuth1 token buys the bearer. Also signed. */
  private async exchange(): Promise<void> {
    if (!this.oauth1) throw new GarminAuthError('oauth2 exchange', 'no OAuth1 token held');
    const url = `${CONNECT_API}/oauth-service/oauth/exchange/user/2.0`;
    const form: Record<string, string> = { audience: 'GARMIN_CONNECT_MOBILE_ANDROID_DI' };
    if (this.oauth1.mfaToken) form.mfa_token = this.oauth1.mfaToken;

    const token: Token = { token: this.oauth1.token, secret: this.oauth1.secret };
    const res = await this.step('oauth2 exchange', url, {
      method: 'POST',
      headers: {
        ...OAUTH_UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: authHeader('POST', url, form, this.consumer, token),
      },
      body: new URLSearchParams(form).toString(),
    });

    const json = await res.json().catch(() => null) as
      { access_token?: string; expires_in?: number } | null;
    if (!json?.access_token) {
      throw new GarminAuthError('oauth2 exchange', 'no access_token in the response');
    }
    // Trust Garmin's own expiry rather than guessing an interval. The
    // previous version re-logged in every three hours on a hunch.
    const ttl = isUsable(json.expires_in) ? json.expires_in : 3600;
    this.oauth2 = { bearer: json.access_token, expiresAt: Date.now() + ttl * 1000 };
    this.save('garmin_oauth2', this.oauth2);
  }

  /**
   * A pinned consumer that Garmin has stopped accepting is the one case
   * worth reaching outside for: it self-heals without trusting the
   * bucket on every login.
   */
  private async refreshConsumer(): Promise<boolean> {
    if (this.consumer !== PINNED_CONSUMER) return false;   // already tried
    try {
      const res = await fetch(CONSUMER_FALLBACK_URL);
      const json = await res.json() as { consumer_key?: string; consumer_secret?: string };
      if (!json?.consumer_key || !json?.consumer_secret) return false;
      this.consumer = { key: json.consumer_key, secret: json.consumer_secret };
      return true;
    } catch {
      return false;
    }
  }

  private async step(step: string, url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new GarminAuthError(step, `network error: ${e instanceof Error ? e.message : e}`);
    }
    if (res.status === 401 && step.startsWith('oauth') && await this.refreshConsumer()) {
      throw new GarminAuthError(step,
        'the pinned consumer credential was rejected; a replacement has been fetched '
        + 'and the next sync will retry with it');
    }
    if (res.status >= 400) throw new GarminAuthError(step, `HTTP ${res.status}`);
    return res;
  }

  // ---------------------------------------------------------------
  // Pull
  // ---------------------------------------------------------------

  private async api<T>(what: string, path: string): Promise<T> {
    if (!this.oauth2) throw new GarminPullError(what, 'not logged in');
    let res: Response;
    try {
      res = await fetch(`${CONNECT_API}${path}`, {
        headers: {
          ...OAUTH_UA,
          Authorization: `Bearer ${this.oauth2.bearer}`,
          NK: 'NT',
          Accept: 'application/json',
        },
      });
    } catch (e) {
      throw new GarminPullError(what, `network error: ${e instanceof Error ? e.message : e}`);
    }
    if (res.status === 401) {
      this.oauth2 = null;              // the OAuth1 token is probably still good
      throw new GarminPullError(what, 'session rejected (401) - will re-authenticate next sync');
    }
    if (!res.ok) throw new GarminPullError(what, `HTTP ${res.status}`);
    return await res.json() as T;
  }

  /**
   * The daily endpoints take the profile display name in the URL PATH.
   * Omitting it does not 404 - it 403s, which reads like an auth problem
   * and is not one.
   */
  private async profileName(): Promise<string> {
    if (this.displayName) return this.displayName;
    const profile = await this.api<{ displayName?: string }>(
      'profile', '/userprofile-service/socialProfile');
    if (!profile?.displayName) {
      throw new GarminPullError('profile', 'the account has no displayName');
    }
    this.displayName = profile.displayName;
    return this.displayName;
  }

  async pull(since: string): Promise<GarminPull> {
    // One day past UTC today, so a user east of Greenwich never has their
    // current local day left unfetched. See the note in poller.ts.
    const today = pullEndDate();
    const who = encodeURIComponent(await this.profileName());

    const activities = await this.api<unknown[]>('activities',
      '/activitylist-service/activities/search/activities'
      + `?startDate=${since}&endDate=${today}&limit=200`);

    // HRV has a range endpoint, so the whole window costs one request
    // instead of one per day.
    const hrv = await this.api<{ hrvSummaries?: unknown[] }>('hrv',
      `/hrv-service/hrv/daily/${since}/${today}`).catch(() => null);
    const hrvByDate = new Map<string, number>();
    for (const row of hrv?.hrvSummaries ?? []) {
      const r = row as { calendarDate?: string; lastNightAvg?: number };
      if (typeof r?.calendarDate === 'string' && isUsable(r.lastNightAvg)) {
        hrvByDate.set(r.calendarDate, r.lastNightAvg);
      }
    }

    const days: GarminDay[] = [];
    for (const date of datesBetween(since, today)) {
      // One day at a time: the daily-summary endpoints are per-date, and
      // a failure on one day should not lose the rest of the window.
      try {
        const [summary, sleep] = await Promise.all([
          this.api<unknown>(`summary ${date}`,
            `/usersummary-service/usersummary/daily/${who}?calendarDate=${date}`),
          this.api<unknown>(`sleep ${date}`,
            `/wellness-service/wellness/dailySleepData/${who}`
            + `?date=${date}&nonSleepBufferMinutes=60`).catch(() => null),
        ]);
        const day = normaliseDay(date, summary, sleep, hrvByDate.get(date));
        if (Object.keys(day.metrics).length > 0) days.push(day);
      } catch {
        // A missing day is missing, not zero.
      }
    }

    return {
      activities: activities.map(normaliseActivity).filter((a): a is GarminActivity => a !== null),
      days,
    };
  }
}

// -----------------------------------------------------------------
// Cookies. getSetCookie is the only correct way to read multiple
// Set-Cookie headers; the plain get() folds them into one unusable
// string.
// -----------------------------------------------------------------

function absorbCookies(res: Response, into: Map<string, string>): void {
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) into.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

const cookieHeader = (cookies: Map<string, string>) =>
  [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  // A guard rather than a while(true): a bad date pair should not spin.
  for (let i = 0; cursor <= end && i < 400; i++) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Garmin's activity JSON to ours. Local wall time is preserved because
 * that is what the schema stores; a UTC conversion here would file an
 * early-morning run on the previous day for anyone east of Greenwich.
 */
export function normaliseActivity(raw: unknown): GarminActivity | null {
  const a = raw as Record<string, any> | null;
  const startedAt = typeof a?.startTimeLocal === 'string'
    ? a.startTimeLocal.replace(' ', 'T')
    : null;
  if (!startedAt) return null;
  return {
    startedAt,
    kind: a?.activityType?.typeKey ?? null,
    durationMin: isUsable(a?.duration) ? Math.round((a.duration / 60) * 100) / 100 : null,
    kcal: isUsable(a?.calories) ? a.calories : null,
    title: typeof a?.activityName === 'string' ? a.activityName : null,
    // Context, not inputs: nothing in the energy model reads these. They
    // are stored so a week can be reviewed without opening Garmin.
    distanceM: isUsable(a?.distance) ? Math.round(a.distance) : null,
    avgHr: isUsable(a?.averageHR) ? Math.round(a.averageHR) : null,
    trainingLoad: isUsable(a?.activityTrainingLoad) ? a.activityTrainingLoad : null,
    aerobicEffect: isUsable(a?.aerobicTrainingEffect) ? a.aerobicTrainingEffect : null,
    anaerobicEffect: isUsable(a?.anaerobicTrainingEffect) ? a.anaerobicTrainingEffect : null,
  };
}

/**
 * Daily summary and sleep to our metric keys.
 *
 * Every field is optional and absent means absent. A watch left on the
 * charger produces no steps, and recording zero for that would invent a
 * measurement - which is the one thing this whole application refuses to
 * do.
 */
export function normaliseDay(
  date: string, rawSummary: unknown, rawSleep: unknown, hrv?: number,
): GarminDay {
  const summary = rawSummary as Record<string, any> | null;
  const sleep = rawSleep as Record<string, any> | null;
  const metrics: GarminDay['metrics'] = {};
  const put = (key: keyof GarminDay['metrics'], v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) metrics[key] = v;
  };
  const num = (v: unknown) => (isUsable(v) ? v : undefined);

  put('steps', num(summary?.totalSteps));
  put('rhr_bpm', num(summary?.restingHeartRate));
  put('body_battery_max', num(summary?.bodyBatteryHighestValue));
  put('body_battery_min', num(summary?.bodyBatteryLowestValue));

  // Garmin reports -1 for "not measured" on the stress fields, and -1
  // minutes of stress is worse than no reading at all.
  const nonNegative = (v: unknown) => (isUsable(v) && v >= 0 ? v : undefined);
  put('stress_avg', nonNegative(summary?.averageStressLevel));
  put('stress_max', nonNegative(summary?.maxStressLevel));
  put('stress_rest_min', nonNegative(summary?.restStressDuration) !== undefined
    ? secondsToMinutes(summary?.restStressDuration) : undefined);
  put('stress_high_min', nonNegative(summary?.highStressDuration) !== undefined
    ? secondsToMinutes(summary?.highStressDuration) : undefined);

  const dto = sleep?.dailySleepDTO ?? {};
  put('sleep_min', secondsToMinutes(dto.sleepTimeSeconds));
  put('rem_min', secondsToMinutes(dto.remSleepSeconds));
  put('deep_min', secondsToMinutes(dto.deepSleepSeconds));
  put('light_min', secondsToMinutes(dto.lightSleepSeconds));
  put('awake_min', secondsToMinutes(dto.awakeSleepSeconds));
  put('sleep_score', num(dto.sleepScores?.overall?.value));

  // The range endpoint is authoritative; the sleep payload is a fallback
  // for the days it did not cover.
  put('hrv_ms', num(hrv) ?? num(dto.avgOvernightHrv) ?? num(sleep?.avgOvernightHrv));

  return { logDate: date, metrics };
}
