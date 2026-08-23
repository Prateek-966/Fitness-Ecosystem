/**
 * The contract every Garmin adapter satisfies.
 *
 * Deliberately tiny and deliberately isolated. The Connect implementation
 * talks to an undocumented, changeable surface; keeping it behind this
 * interface means when Garmin moves something, one file is wrong and the
 * scheduler, the store, the API and the app are all still right.
 */

export interface GarminActivity {
  startedAt: string;            // local ISO, no zone suffix
  kind: string | null;
  durationMin: number | null;
  kcal: number | null;
  title: string | null;
}

export interface GarminDay {
  logDate: string;              // YYYY-MM-DD
  metrics: Partial<Record<
    'sleep_min' | 'rem_min' | 'deep_min' | 'rhr_bpm' |
    'hrv_ms' | 'stress_avg' | 'body_battery_max' | 'steps', number>>;
}

export interface GarminPull {
  activities: GarminActivity[];
  days: GarminDay[];
}

export interface GarminClient {
  readonly name: string;
  /** Establish or restore a session. Throws with a diagnosable message. */
  login(): Promise<void>;
  /** Everything from `since` (inclusive) to today. */
  pull(since: string): Promise<GarminPull>;
}

/** A metric value we would rather drop than guess at. */
export const isUsable = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Garmin reports sleep and similar in seconds; the app stores minutes. */
export const secondsToMinutes = (s: unknown): number | undefined =>
  isUsable(s) && s > 0 ? Math.round((s / 60) * 10) / 10 : undefined;
