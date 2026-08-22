import type { Db } from './db';
import { localIso } from './clock';

/**
 * Meal slots are DERIVED, never hard-coded.
 *
 * A nutrition app that decides lunch is 12:00-14:00 is describing its own
 * assumptions, not your day. These windows come out of when you actually
 * logged — first from the Healthify history, later from your own entries
 * once there are enough of them.
 *
 * 1-D k-means over minutes-past-midnight, k=4, seeded deterministically by
 * quantile so the same data always produces the same windows. Stability
 * matters here for the same reason it matters everywhere else in this app.
 */

export const SLOT_NAMES = ['breakfast', 'lunch', 'snack', 'dinner'] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export interface SlotWindow {
  slot: SlotName;
  centreMin: number;
  startMin: number;
  endMin: number;
  nObservations: number;
}

export function minutesOfDay(iso: string): number | null {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Exact 1-D clustering by dynamic programming (the Ckmeans.1d.dp
 * formulation): the partition into k contiguous groups that minimises
 * total within-group sum of squares.
 *
 * k-means was the obvious choice and the wrong one. Seeded by quantile it
 * puts two centres inside whichever eating occasion you log most and none
 * near the one you log least, so a real 17:00 snack disappears into lunch
 * while dinner gets split in half. In one dimension the exact answer is
 * cheap, so there is no reason to accept a seeding artefact — and "same
 * data, same windows, every time" is not negotiable in an app whose entire
 * thesis is consistency.
 */
export function cluster(values: number[], k = 4): number[][] {
  if (values.length === 0) return [];
  const xs = [...values].sort((a, b) => a - b);
  const n = xs.length;
  const kk = Math.min(k, new Set(xs).size);
  if (kk <= 1) return [xs];

  // Prefix sums, so the cost of any contiguous run is O(1).
  const s1 = new Float64Array(n + 1);
  const s2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    s1[i + 1] = s1[i] + xs[i];
    s2[i + 1] = s2[i] + xs[i] * xs[i];
  }
  /** Within-group sum of squares for xs[i..j], inclusive, 0-based. */
  const sse = (i: number, j: number) => {
    const cnt = j - i + 1;
    const sum = s1[j + 1] - s1[i];
    return s2[j + 1] - s2[i] - (sum * sum) / cnt;
  };

  // cost[m][i] = best cost of splitting the first i points into m groups.
  const cost: Float64Array[] = [];
  const split: Int32Array[] = [];
  for (let m = 0; m <= kk; m++) {
    cost.push(new Float64Array(n + 1).fill(Infinity));
    split.push(new Int32Array(n + 1));
  }
  cost[0][0] = 0;

  for (let m = 1; m <= kk; m++) {
    for (let i = m; i <= n; i++) {
      for (let j = m - 1; j < i; j++) {
        const c = cost[m - 1][j] + sse(j, i - 1);
        if (c < cost[m][i]) {
          cost[m][i] = c;
          split[m][i] = j;
        }
      }
    }
  }

  const out: number[][] = [];
  let end = n;
  for (let m = kk; m >= 1; m--) {
    const start = split[m][end];
    out.unshift(xs.slice(start, end));
    end = start;
  }
  return out.filter((c) => c.length > 0);
}

/**
 * Two logs twenty minutes apart are one eating occasion, not two. k-means
 * with a fixed k has no way to know that and will happily split a single
 * breakfast in half to spend its fourth cluster, so adjacent clusters
 * closer together than this are merged afterwards.
 */
export const MIN_SLOT_SEPARATION_MIN = 90;

function mergeClose(clusters: number[][], minGap: number): number[][] {
  const sorted = [...clusters].sort((a, b) => mean(a) - mean(b));
  const out: number[][] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && mean(c) - mean(prev) < minGap) {
      out[out.length - 1] = [...prev, ...c].sort((a, b) => a - b);
    } else {
      out.push([...c]);
    }
  }
  return out;
}

export function deriveWindows(timestamps: string[]): SlotWindow[] {
  const mins = timestamps.map(minutesOfDay).filter((m): m is number => m !== null);
  if (mins.length < 4) return [];

  const clusters = mergeClose(cluster(mins, 4), MIN_SLOT_SEPARATION_MIN);

  // Fewer than four clusters means fewer than four real eating times.
  // Name what exists rather than inventing a slot to fill the list.
  const names: SlotName[] =
    clusters.length === 4 ? ['breakfast', 'lunch', 'snack', 'dinner']
    : clusters.length === 3 ? ['breakfast', 'lunch', 'dinner']
    : clusters.length === 2 ? ['lunch', 'dinner']
    : ['lunch'];

  return clusters.map((c, i) => ({
    slot: names[i],
    centreMin: round1(mean(c)),
    startMin: c[0],
    endMin: c[c.length - 1],
    nObservations: c.length,
  }));
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Derive windows from whatever record of your behaviour exists.
 *
 * Imported history first, because six months beats six days. Failing
 * that, your own log once there is enough of it - a handful of entries
 * describes a habit no better than a coin describes a distribution, and
 * windows that lurch about each time you log lunch are worse than no
 * windows at all.
 *
 * Returns null when neither source qualifies. A day that is not yet
 * grouped is honest; groups invented from a default schedule are not.
 */
export const MIN_ENTRIES_TO_DERIVE = 8;

export function autoRefreshWindows(db: Db): SlotWindow[] {
  const imported = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM imported_entry')!.n;
  if (imported >= MIN_ENTRIES_TO_DERIVE) return refreshWindows(db, 'imported_entry');

  const logged = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM log_entry')!.n;
  if (logged >= MIN_ENTRIES_TO_DERIVE) return refreshWindows(db, 'log_entry');

  return [];
}

export function listWindows(db: Db): SlotWindow[] {
  return db.all<any>(
    `SELECT slot, centre_min AS centreMin, start_min AS startMin,
            end_min AS endMin, n_observations AS nObservations
     FROM meal_slot_window ORDER BY centre_min`,
  );
}

export function refreshWindows(
  db: Db, from: 'imported_entry' | 'log_entry' = 'imported_entry',
): SlotWindow[] {
  const rows = db.all<{ t: string }>(
    from === 'imported_entry'
      ? 'SELECT eaten_at AS t FROM imported_entry'
      : 'SELECT eaten_at AS t FROM log_entry',
  );
  const windows = deriveWindows(rows.map((r) => r.t));
  if (windows.length === 0) return [];

  const now = localIso();
  db.tx(() => {
    db.run('DELETE FROM meal_slot_window');
    for (const w of windows) {
      db.run(
        `INSERT INTO meal_slot_window
           (slot, centre_min, start_min, end_min, n_observations, derived_at, derived_from)
         VALUES (?,?,?,?,?,?,?)`,
        [w.slot, w.centreMin, w.startMin, w.endMin, w.nObservations, now, from],
      );
    }
  });
  return windows;
}

/**
 * Nearest derived centre wins. Returns null when no windows have been
 * derived yet — a null meal_slot is honest, a guessed one is not.
 */
export function slotFor(db: Db, at: Date): SlotName | null {
  const rows = db.all<{ slot: SlotName; centre_min: number }>(
    'SELECT slot, centre_min FROM meal_slot_window',
  );
  if (rows.length === 0) return null;
  const m = at.getHours() * 60 + at.getMinutes();
  let best: SlotName | null = null;
  let bd = Infinity;
  for (const r of rows) {
    // Wrap around midnight: a 23:40 log is nearer to a 20:00 dinner centre
    // than the raw difference suggests once the day is treated as a circle.
    const d = Math.min(Math.abs(m - r.centre_min), 1440 - Math.abs(m - r.centre_min));
    if (d < bd) { bd = d; best = r.slot; }
  }
  return best;
}
