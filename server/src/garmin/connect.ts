import type { GarminActivity, GarminClient, GarminDay, GarminPull } from './client.ts';
import { isUsable, secondsToMinutes } from './client.ts';
import { pullEndDate } from '../poller.ts';

/**
 * Garmin Connect adapter.
 *
 * WHAT THIS IS, HONESTLY. Garmin's official Health API is a partner
 * programme: it requires application and approval, is not self-serve, and
 * is not obtainable for a personal project on demand. This adapter
 * therefore uses the same route every self-hosted Garmin project uses -
 * the Connect web SSO, signing in as you with your own credentials.
 *
 * The consequences, stated rather than buried:
 *  - It is UNDOCUMENTED and unversioned. Garmin can change it without
 *    notice, and periodically does. When it breaks, this file is what is
 *    wrong; everything around it keeps working, which is why it is
 *    isolated behind a four-method interface.
 *  - It stores a session for your account. Run this only on
 *    infrastructure you control.
 *  - Multi-factor authentication is not handled. If your account has MFA
 *    enabled, this login will fail with a clear message rather than a
 *    confusing one, and file import remains available.
 *
 * The official API, if you are ever granted access, slots in as a second
 * adapter against the same interface without touching anything else.
 *
 * NOT VERIFIED AGAINST LIVE GARMIN. The development environment for this
 * project has no outbound network access, so this flow is written to the
 * documented shape but has never received a real response. Every step
 * fails loudly and separately so the first run tells you exactly which
 * one is wrong.
 */

const SSO_ORIGIN = 'https://sso.garmin.com';
const CONNECT_API = 'https://connectapi.garmin.com';
const CONNECT_WEB = 'https://connect.garmin.com';

/** Garmin rejects unrecognised clients, so present a normal browser. */
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

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

interface Session {
  cookies: Map<string, string>;
  bearer: string | null;
  obtainedAt: number;
}

export class ConnectGarmin implements GarminClient {
  readonly name = 'connect';
  private session: Session | null = null;

  // Explicit fields: see the note in poller.ts - strip-only mode cannot
  // synthesise parameter properties.
  private email: string;
  private password: string;

  constructor(email: string, password: string) {
    this.email = email;
    this.password = password;
  }

  private cookieHeader(): string {
    if (!this.session) return '';
    return [...this.session.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorbCookies(res: Response): void {
    if (!this.session) return;
    // getSetCookie is the only correct way to read multiple Set-Cookie
    // headers; the plain get() folds them into one unusable string.
    const raw = (res.headers as unknown as { getSetCookie?: () => string[] })
      .getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.session.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  /**
   * The Connect SSO dance: collect cookies, post credentials, receive a
   * one-time ticket, exchange it for a bearer token.
   */
  async login(): Promise<void> {
    // Sessions last hours; re-using one avoids hammering their SSO.
    if (this.session?.bearer && Date.now() - this.session.obtainedAt < 3 * 3600_000) return;

    this.session = { cookies: new Map(), bearer: null, obtainedAt: Date.now() };

    const embedUrl = `${SSO_ORIGIN}/sso/embed?clientId=GarminConnect`
      + `&service=${encodeURIComponent(`${SSO_ORIGIN}/sso/embed`)}`;
    let res = await this.fetchStep('embed', embedUrl, { headers: { 'User-Agent': UA } });
    this.absorbCookies(res);

    const signinUrl = `${SSO_ORIGIN}/sso/signin?clientId=GarminConnect`
      + `&service=${encodeURIComponent(`${CONNECT_WEB}/modern`)}`
      + `&gauthHost=${encodeURIComponent(`${SSO_ORIGIN}/sso`)}`;
    res = await this.fetchStep('signin page', signinUrl, {
      headers: { 'User-Agent': UA, Cookie: this.cookieHeader() },
    });
    this.absorbCookies(res);
    const page = await res.text();

    // Their form carries a CSRF token that must be echoed back.
    const csrf = /name="_csrf"\s+value="([^"]+)"/.exec(page)?.[1];
    if (!csrf) {
      throw new GarminAuthError('signin page',
        'no CSRF token in the response - Garmin has probably changed the login page');
    }

    res = await this.fetchStep('credentials', signinUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Cookie: this.cookieHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: signinUrl,
      },
      body: new URLSearchParams({
        username: this.email,
        password: this.password,
        embed: 'false',
        _csrf: csrf,
      }).toString(),
    });
    this.absorbCookies(res);
    const body = await res.text();

    if (/mfa|verification code/i.test(body)) {
      throw new GarminAuthError('credentials',
        'this account requires multi-factor authentication, which this adapter does not '
        + 'support. Use the CSV import instead, or disable MFA for this account.');
    }

    const ticket = /ticket=([^"&']+)/.exec(body)?.[1];
    if (!ticket) {
      throw new GarminAuthError('credentials',
        /error/i.test(body)
          ? 'Garmin rejected the credentials'
          : 'no service ticket returned - credentials may be wrong, or the flow has changed');
    }

    const exchange = await this.fetchStep('token exchange',
      `${CONNECT_API}/oauth-service/oauth/exchange/user/2.0?ticket=${encodeURIComponent(ticket)}`,
      { method: 'POST', headers: { 'User-Agent': UA, Cookie: this.cookieHeader() } });

    const token = await exchange.json().catch(() => null) as { access_token?: string } | null;
    if (!token?.access_token) {
      throw new GarminAuthError('token exchange', 'no access_token in the response');
    }

    this.session.bearer = token.access_token;
    this.session.obtainedAt = Date.now();
  }

  private async fetchStep(step: string, url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new GarminAuthError(step, `network error: ${e instanceof Error ? e.message : e}`);
    }
    // 3xx is expected at the credential step; only 4xx/5xx are failures.
    if (res.status >= 400) throw new GarminAuthError(step, `HTTP ${res.status}`);
    return res;
  }

  private async api<T>(what: string, path: string): Promise<T> {
    if (!this.session?.bearer) throw new GarminPullError(what, 'not logged in');
    let res: Response;
    try {
      res = await fetch(`${CONNECT_API}${path}`, {
        headers: {
          'User-Agent': UA,
          Authorization: `Bearer ${this.session.bearer}`,
          'NK': 'NT',
          Accept: 'application/json',
        },
      });
    } catch (e) {
      throw new GarminPullError(what, `network error: ${e instanceof Error ? e.message : e}`);
    }
    if (res.status === 401) {
      this.session = null;   // force a fresh login next time
      throw new GarminPullError(what, 'session rejected (401) - will re-login next sync');
    }
    if (!res.ok) throw new GarminPullError(what, `HTTP ${res.status}`);
    return await res.json() as T;
  }

  async pull(since: string): Promise<GarminPull> {
    // One day past UTC today, so a user east of Greenwich never has their
    // current local day left unfetched. See the note in poller.ts.
    const today = pullEndDate();

    const activities = await this.api<any[]>('activities',
      `/activitylist-service/activities/search/activities`
      + `?startDate=${since}&endDate=${today}&limit=200`);

    const days: GarminDay[] = [];
    for (const date of datesBetween(since, today)) {
      // One day at a time: their daily-summary endpoints are per-date, and
      // a failure on one day should not lose the rest of the window.
      try {
        const [summary, sleep] = await Promise.all([
          this.api<any>(`summary ${date}`,
            `/usersummary-service/usersummary/daily?calendarDate=${date}`),
          this.api<any>(`sleep ${date}`,
            `/wellness-service/wellness/dailySleepData?date=${date}&nonSleepBufferMinutes=60`)
            .catch(() => null),
        ]);
        const day = normaliseDay(date, summary, sleep);
        if (Object.keys(day.metrics).length > 0) days.push(day);
      } catch {
        // A missing day is missing, not zero. Skip it and keep going.
      }
    }

    return { activities: activities.map(normaliseActivity).filter(Boolean) as GarminActivity[], days };
  }
}

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
export function normaliseActivity(a: any): GarminActivity | null {
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
export function normaliseDay(date: string, summary: any, sleep: any): GarminDay {
  const metrics: GarminDay['metrics'] = {};
  const put = (key: keyof GarminDay['metrics'], v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) metrics[key] = v;
  };

  put('steps', isUsable(summary?.totalSteps) ? summary.totalSteps : undefined);
  put('rhr_bpm', isUsable(summary?.restingHeartRate) ? summary.restingHeartRate : undefined);
  put('stress_avg', isUsable(summary?.averageStressLevel) && summary.averageStressLevel >= 0
    ? summary.averageStressLevel : undefined);
  put('body_battery_max', isUsable(summary?.bodyBatteryHighestValue)
    ? summary.bodyBatteryHighestValue : undefined);

  const dto = sleep?.dailySleepDTO ?? {};
  put('sleep_min', secondsToMinutes(dto.sleepTimeSeconds));
  put('rem_min', secondsToMinutes(dto.remSleepSeconds));
  put('deep_min', secondsToMinutes(dto.deepSleepSeconds));

  const hrv = dto.avgOvernightHrv ?? sleep?.avgOvernightHrv;
  put('hrv_ms', isUsable(hrv) ? hrv : undefined);

  return { logDate: date, metrics };
}
