/**
 * Time, handled once, in two respects the rest of the code relies on.
 *
 * absNow: performance.now() is relative to each context's own time origin,
 * so a mic tap timed on the main thread and a commit timed in the database
 * worker are not comparable. Adding timeOrigin gives both a shared epoch
 * with sub-millisecond resolution — which matters when the whole capture
 * budget is 3000 ms.
 *
 * localIso: every timestamp this app stores is DEVICE-LOCAL wall time,
 * as the schema documents ("ISO8601, device local", with tz_offset_min
 * stored beside it). Date.toISOString() is UTC, and storing UTC breaks
 * every local-day boundary in the design: date(eaten_at) groups a 00:30
 * IST dinner onto yesterday, the streak count misses days, and meal-slot
 * windows derived from local Healthify history sit 5½ hours away from
 * log entries. "What day was this" is a wall-clock question everywhere
 * in this schema, so wall-clock is what gets stored.
 */

export const absNow = (): number => performance.timeOrigin + performance.now();

/** Local wall-clock time as ISO-8601, no zone suffix. e.g. 2026-08-22T00:30:00.000 */
export function localIso(d: Date = new Date()): string {
  // getTimezoneOffset is per-instant, so DST transitions resolve correctly.
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, -1);
}

/** Local calendar date, YYYY-MM-DD. */
export function localDate(d: Date = new Date()): string {
  return localIso(d).slice(0, 10);
}
