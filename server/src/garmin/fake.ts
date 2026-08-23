import type { GarminClient, GarminPull } from './client.ts';

/**
 * A deterministic stand-in for Garmin.
 *
 * Exists so the parts that must be right - scheduling, retry, storage,
 * authentication, the shape crossing the wire, idempotency on the app
 * side - are testable without a network or an account. The real adapter
 * cannot be tested in CI; everything around it can, and is.
 */
export class FakeGarmin implements GarminClient {
  readonly name = 'fake';
  loginCalls = 0;
  pullCalls = 0;
  failLoginWith: Error | null = null;
  failPullWith: Error | null = null;

  private days: number;

  constructor(days = 7) { this.days = days; }

  async login(): Promise<void> {
    this.loginCalls++;
    if (this.failLoginWith) throw this.failLoginWith;
  }

  async pull(since: string): Promise<GarminPull> {
    this.pullCalls++;
    if (this.failPullWith) throw this.failPullWith;

    const start = new Date(`${since}T00:00:00`);
    const activities = [];
    const daysOut = [];
    for (let i = 0; i < this.days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const date = d.toISOString().slice(0, 10);
      const hard = i % 3 === 0;
      daysOut.push({
        logDate: date,
        metrics: {
          sleep_min: hard ? 400 : 445,
          rem_min: 92,
          rhr_bpm: hard ? 54 : 49,
          hrv_ms: hard ? 48 : 61,
          stress_avg: hard ? 44 : 28,
          steps: hard ? 14200 : 8100,
        },
      });
      if (hard) {
        activities.push({
          startedAt: `${date}T06:30:00`,
          kind: 'Running',
          durationMin: 48.25,
          kcal: 620,
          title: 'Morning Run',
        });
      }
    }
    return { activities, days: daysOut };
  }
}
