import type { GarminClient } from './garmin/client.ts';
import type { SyncStore } from './store.ts';

/**
 * Pulls on a schedule, and keeps an honest record of how it went.
 *
 * A sync that fails silently is worse than no sync: you would carry on
 * believing the numbers were fresh. Every outcome - success, failure, the
 * error text - is stored and served on /api/garmin/status.
 */

export interface SyncResult {
  ok: boolean;
  at: string;
  activities: number;
  metrics: number;
  error: string | null;
  durationMs: number;
}

/** How far back a first sync reaches. Later syncs overlap by a few days. */
export const FIRST_PULL_DAYS = 28;
export const OVERLAP_DAYS = 3;

/**
 * Dates here are UTC throughout, deliberately and consistently.
 *
 * The server runs in whatever zone its host chose (UTC on Render); the
 * user is somewhere else. Mixing the two - parsing a stored date as local
 * and formatting it back as UTC - shifts the window by a day, which was
 * exactly the bug this note replaces. The skew against the user's own
 * calendar is absorbed by pulling one day PAST today and by the
 * multi-day overlap, both of which are free given upserts.
 */
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (date: string) => new Date(`${date}T00:00:00Z`);
const shifted = (n: number, from = new Date()) => {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
};
const daysAgo = (n: number) => shifted(-n);

/**
 * The end of the pull window: one day past UTC today.
 *
 * A user east of Greenwich is already on tomorrow's date while the server
 * still thinks it is today. Ending at UTC today would leave their current
 * day unfetched until the small hours.
 */
export const pullEndDate = () => shifted(1);

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Explicit fields, not constructor parameter properties: Node's
  // strip-only TypeScript mode removes annotations without synthesising
  // the assignments a parameter property implies, and this file runs
  // under that mode in the container.
  private client: GarminClient;
  private store: SyncStore;
  private intervalMin: number;

  constructor(client: GarminClient, store: SyncStore, intervalMin: number) {
    this.client = client;
    this.store = store;
    this.intervalMin = intervalMin;
  }

  /**
   * Overlaps the previous window by a few days rather than resuming
   * exactly where it stopped. Garmin backfills - a night's sleep can be
   * revised hours later - and an upsert makes the overlap free.
   */
  nextSince(): string {
    const last = this.store.get('last_success_date');
    if (!last) return daysAgo(FIRST_PULL_DAYS);
    return shifted(-OVERLAP_DAYS, utcMidnight(last));
  }

  async syncOnce(): Promise<SyncResult> {
    // One at a time. A slow pull overlapping a scheduled one would double
    // the load on Garmin and interleave two writes for no benefit.
    if (this.running) {
      return {
        ok: false, at: new Date().toISOString(), activities: 0, metrics: 0,
        error: 'a sync is already running', durationMs: 0,
      };
    }
    this.running = true;
    const started = Date.now();
    const at = new Date().toISOString();

    try {
      await this.client.login();
      const pull = await this.client.pull(this.nextSince());
      const saved = this.store.save(pull);
      this.store.set('last_success_at', at);
      this.store.set('last_success_date', isoDate(new Date()));
      this.store.set('last_error', '');
      // Ninety days is plenty of buffer for an app that keeps its own copy.
      this.store.prune(daysAgo(90));
      return { ok: true, at, ...saved, error: null, durationMs: Date.now() - started };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.store.set('last_error', error);
      this.store.set('last_error_at', at);
      return {
        ok: false, at, activities: 0, metrics: 0, error,
        durationMs: Date.now() - started,
      };
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.syncOnce();
    this.timer = setInterval(() => void this.syncOnce(), this.intervalMin * 60_000);
    // Do not hold the process open for the sake of a timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      adapter: this.client.name,
      running: this.running,
      intervalMin: this.intervalMin,
      lastSuccessAt: this.store.get('last_success_at'),
      lastError: this.store.get('last_error') || null,
      lastErrorAt: this.store.get('last_error_at'),
      nextSince: this.nextSince(),
    };
  }
}
