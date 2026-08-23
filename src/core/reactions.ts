import type { Db } from './db.ts';
import { localDate } from './clock.ts';

/**
 * "Does anything I eat affect my sleep or my stress?"
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID. Test forty foods against sleep
 * and roughly two will look significant at p < 0.05 from noise alone.
 * A naive version of this file would confidently announce that paneer
 * ruins your sleep, you would stop eating paneer, and the app would
 * have made you worse off while sounding scientific. That is the single
 * most likely way this feature does harm, so it is handled first rather
 * than last:
 *
 *  - A PERMUTATION TEST, not a t-test. No distributional assumption,
 *    exact by construction, and honest at the small sample sizes this
 *    will actually run on. The shuffle is SEEDED, so the same data
 *    always gives the same answer - the same requirement that made
 *    meal-slot clustering exact rather than k-means.
 *  - BENJAMINI-HOCHBERG across every food tested, so the answer accounts
 *    for how many questions were asked. `nTested` is reported alongside,
 *    because a reader who cannot see how many comparisons were made
 *    cannot judge the one they are being shown.
 *  - A minimum number of days on BOTH sides. "You slept badly the one
 *    time you ate biryani" is an anecdote.
 *
 * AND IT IS STILL ONLY ASSOCIATION. Late dinners and heavy dinners and
 * drinking nights arrive together; this cannot separate them, and says
 * so in every result it returns. The honest use is to generate a
 * hypothesis you then test on purpose, which is what stage 5 is for.
 *
 * This is PULL, never push: nothing here runs unless asked. Principle 8
 * still holds - the app does not volunteer opinions about your food.
 */

export type ReactionMetric = 'sleep_min' | 'sleep_score' | 'stress_avg'
  | 'hrv_ms' | 'rhr_bpm' | 'deep_min' | 'rem_min' | 'awake_min';

export interface Reaction {
  foodId: number;
  food: string;
  metric: ReactionMetric;
  /** Mean of the metric on days following days the food was eaten. */
  meanWith: number;
  meanWithout: number;
  difference: number;
  nWith: number;
  nWithout: number;
  /** Permutation p-value, two-sided. */
  p: number;
  /** Benjamini-Hochberg adjusted, across every food tested in this run. */
  pAdjusted: number;
  /**
   * Survives correction AND is big enough to act on. Both are required:
   * a statistically detectable five-minute difference in sleep is not a
   * reason to give up a food.
   */
  notable: boolean;
  basis: string;
}

export interface ReactionOptions {
  metric?: ReactionMetric;
  /**
   * Days between eating and the measurement. 1 for sleep, because
   * Garmin files a night's sleep under the morning it ended, so last
   * night's dinner sits on the previous calendar day.
   *
   * ASSUMPTION, not a measurement. If a real export shows Garmin filing
   * sleep under the evening it began, this is 0 and every sleep result
   * here is shifted by a day. Worth checking against live data before
   * trusting any sleep finding.
   */
  offsetDays?: number;
  /** Only count the food when eaten in this slot. */
  slot?: 'breakfast' | 'lunch' | 'snack' | 'dinner';
  days?: number;
  minDaysEach?: number;
  /** False discovery rate for the correction. */
  fdr?: number;
  /** Smallest difference worth reporting. Defaults per metric. */
  minEffect?: number;
  permutations?: number;
}

/**
 * The smallest difference in each metric that is worth a person's
 * attention, let alone a change of diet.
 *
 * These are deliberately blunt. The asymmetry is the argument: a false
 * positive means the owner stops eating something for no reason, a
 * false negative means he does not learn something he could learn later
 * anyway. The first is much the worse outcome, so the bar sits high.
 */
const MIN_EFFECT: Record<ReactionMetric, number> = {
  sleep_min: 20,
  deep_min: 10,
  rem_min: 10,
  awake_min: 10,
  sleep_score: 5,
  stress_avg: 5,
  hrv_ms: 5,
  rhr_bpm: 3,
};

/** Deterministic PRNG: same data must always give the same answer. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (v: number, dp = 2) => Number(v.toFixed(dp));

export function foodReactions(
  db: Db, opts: ReactionOptions = {}, today = localDate(),
): { reactions: Reaction[]; nTested: number; caveat: string } {
  const raw = rawReactions(db, opts, today);
  if (raw.length === 0) {
    return { reactions: [], nTested: 0, caveat: raw.caveat };
  }
  const reactions = correct(raw, opts.fdr ?? 0.05, opts.minEffect);
  return {
    reactions,
    nTested: reactions.length,
    caveat: `${reactions.length} foods tested against ${opts.metric ?? 'sleep_min'}; `
      + 'p-values are corrected for that. '
      + 'These are associations, not causes: late dinners, heavy dinners and '
      + 'drinking nights arrive together and this cannot separate them.',
  };
}

/**
 * Benjamini-Hochberg, plus the effect-size floor.
 *
 * Exported and applied to the WHOLE run rather than per metric: asking
 * "what affects my sleep" and testing three sleep measures against
 * twelve foods is thirty-six comparisons in one family, not three
 * families of twelve. Correcting each metric separately would let three
 * times as much noise through, which is exactly what it did before this
 * was split out.
 */
export function correct(raw: RawList, fdr = 0.05, minEffect?: number): Reaction[] {
  const list = [...raw];
  list.sort((a, b) => a.p - b.p);
  const m = list.length;
  let previous = 1;
  for (let i = m - 1; i >= 0; i--) {
    const adjusted = Math.min(previous, (list[i].p * m) / (i + 1));
    list[i].pAdjusted = round(adjusted, 4);
    const floor = minEffect ?? MIN_EFFECT[list[i].metric] ?? 0;
    list[i].notable = adjusted <= fdr && Math.abs(list[i].difference) >= floor;
    previous = adjusted;
  }
  return list.sort((a, b) => a.pAdjusted - b.pAdjusted);
}

export interface RawList extends Array<Reaction> { caveat: string }

export function rawReactions(
  db: Db, opts: ReactionOptions = {}, today = localDate(),
): RawList {
  const metric = opts.metric ?? 'sleep_min';
  const offset = opts.offsetDays ?? (metric.includes('sleep') || metric === 'deep_min'
    || metric === 'rem_min' || metric === 'awake_min' ? 1 : 0);
  const days = opts.days ?? 90;
  const minEach = opts.minDaysEach ?? 5;
  const permutations = opts.permutations ?? 2000;

  const from = new Date(`${today}T12:00:00`);
  from.setDate(from.getDate() - days);
  const fromDate = localDate(from);

  // The metric series, one value per day.
  const series = new Map<string, number>();
  for (const r of db.all<{ log_date: string; value: number }>(
    `SELECT log_date, value FROM v_daily_metric
      WHERE metric = ? AND log_date >= ? AND log_date <= ?`, [metric, fromDate, today])) {
    series.set(r.log_date, r.value);
  }
  if (series.size < minEach * 2) return withCaveat([], notEnough(series.size, minEach));

  // Which days each food was eaten on.
  const slotClause = opts.slot ? 'AND le.meal_slot = ?' : '';
  const params: any[] = [fromDate, today];
  if (opts.slot) params.push(opts.slot);
  const rows = db.all<{ food_id: number; name: string; log_date: string }>(
    `SELECT DISTINCT le.food_id, f.name, date(le.eaten_at) AS log_date
       FROM log_entry le JOIN food f ON f.id = le.food_id
      WHERE le.status = 'resolved'
        AND date(le.eaten_at) >= ? AND date(le.eaten_at) <= ? ${slotClause}`, params);

  const byFood = new Map<number, { name: string; dates: Set<string> }>();
  for (const r of rows) {
    const e = byFood.get(r.food_id) ?? { name: r.name, dates: new Set<string>() };
    e.dates.add(r.log_date);
    byFood.set(r.food_id, e);
  }

  const allDays = [...series.keys()].sort();
  const raw: Reaction[] = [];

  for (const [foodId, { name, dates }] of byFood) {
    const withVals: number[] = [];
    const withoutVals: number[] = [];
    for (const day of allDays) {
      const eatenOn = shiftDate(day, -offset);
      (dates.has(eatenOn) ? withVals : withoutVals).push(series.get(day)!);
    }
    if (withVals.length < minEach || withoutVals.length < minEach) continue;

    const mWith = mean(withVals);
    const mWithout = mean(withoutVals);
    const observed = Math.abs(mWith - mWithout);

    // Permutation: shuffle which days count as "with", keeping the
    // group sizes fixed, and see how often chance beats what was seen.
    const pool = [...withVals, ...withoutVals];
    const k = withVals.length;
    const next = rng(foodId * 2654435761 + pool.length);
    let atLeastAsExtreme = 0;
    for (let iter = 0; iter < permutations; iter++) {
      // Partial Fisher-Yates: only the first k matter.
      const copy = pool.slice();
      for (let i = 0; i < k; i++) {
        const j = i + Math.floor(next() * (copy.length - i));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      const a = mean(copy.slice(0, k));
      const b = mean(copy.slice(k));
      if (Math.abs(a - b) >= observed) atLeastAsExtreme++;
    }
    // +1 to both, so a p of exactly zero is never claimed from a finite
    // number of shuffles.
    const p = (atLeastAsExtreme + 1) / (permutations + 1);

    raw.push({
      foodId, food: name, metric,
      meanWith: round(mWith, 1),
      meanWithout: round(mWithout, 1),
      difference: round(mWith - mWithout, 1),
      nWith: withVals.length, nWithout: withoutVals.length,
      p: round(p, 4), pAdjusted: 1, notable: false,
      basis: `${withVals.length} days with, ${withoutVals.length} without`,
    });
  }

  return withCaveat(raw, raw.length === 0 ? notEnough(series.size, minEach) : '');
}

function withCaveat(list: Reaction[], caveat: string): RawList {
  const out = list as RawList;
  out.caveat = caveat;
  return out;
}

const notEnough = (nDays: number, minEach: number) =>
  `not enough data yet — ${nDays} days with this measurement, `
  + `and at least ${minEach * 2} are needed before any comparison means anything`;

function shiftDate(date: string, byDays: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + byDays);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------
// The requested-only recommendation surface.
// ------------------------------------------------------------------

export interface WellbeingAdvice {
  topic: 'sleep' | 'stress';
  /** Null when there is not enough data to say anything at all. */
  headline: string;
  findings: string[];
  caveat: string;
  /** Foods worth actually testing on purpose, via stage 5. */
  hypotheses: Array<{ food: string; metric: ReactionMetric; difference: number }>;
}

/**
 * Asked for, never volunteered.
 *
 * Reports what the data associates with sleep or stress, and - this is
 * the part that matters - hands back HYPOTHESES rather than
 * instructions. An association found by trawling is a thing to test on
 * purpose, and `decision_log` is where that test gets recorded.
 */
export function wellbeingAdvice(
  db: Db, topic: 'sleep' | 'stress', today = localDate(),
): WellbeingAdvice {
  const metrics: ReactionMetric[] = topic === 'sleep'
    ? ['sleep_min', 'deep_min', 'awake_min']
    : ['stress_avg', 'hrv_ms'];

  const findings: string[] = [];
  const hypotheses: WellbeingAdvice['hypotheses'] = [];

  // One question, one family of comparisons. Three sleep measures
  // against twelve foods is thirty-six tests, and correcting each
  // measure on its own would let three times as much noise through.
  const pooled: Reaction[] = [];
  for (const metric of metrics) pooled.push(...rawReactions(db, { metric }, today));
  const tested = pooled.length;
  const anyData = tested > 0;

  for (const r of correct(pooled as RawList).filter((x) => x.notable)) {
    const direction = describeDirection(r.metric, r.difference);
    findings.push(
      `${r.food}: ${r.metric.replace('_', ' ')} ${r.difference > 0 ? '+' : ''}`
      + `${r.difference} on days after eating it (${r.basis}, `
      + `adjusted p=${r.pAdjusted}) — ${direction}`);
    hypotheses.push({ food: r.food, metric: r.metric, difference: r.difference });
  }

  // Whatever the food data says, the behavioural baseline is usually
  // the bigger lever and is measured rather than inferred.
  findings.push(...behaviouralFindings(db, topic, today));

  return {
    topic,
    headline: !anyData
      ? `Not enough ${topic} data yet to look for anything`
      : findings.length === 0
        ? `Nothing in your food is associated with your ${topic} beyond chance`
        : `${hypotheses.length} food association${hypotheses.length === 1 ? '' : 's'} worth testing`,
    findings,
    caveat: anyData
      ? `${tested} comparisons were made and the p-values account for that. `
        + 'Association is not cause. Treat these as things to test deliberately, '
        + 'not as rules to follow.'
      : 'Wear the watch and keep logging; this needs a few weeks of both.',
    hypotheses,
  };
}

/** Which way is good depends on the metric, and guessing would be wrong. */
function describeDirection(metric: ReactionMetric, diff: number): string {
  const higherIsBetter: Record<string, boolean> = {
    sleep_min: true, sleep_score: true, deep_min: true, rem_min: true, hrv_ms: true,
    awake_min: false, stress_avg: false, rhr_bpm: false,
  };
  const better = higherIsBetter[metric];
  if (better === undefined) return 'direction unclear';
  return (diff > 0) === better ? 'in the direction you want' : 'in the direction you do not';
}

/**
 * The levers that are measured rather than inferred, and are usually
 * larger than anything a single food does.
 */
function behaviouralFindings(db: Db, topic: 'sleep' | 'stress', today: string): string[] {
  const out: string[] = [];

  if (topic === 'sleep') {
    const late = db.get<{ mean_late: number | null; mean_early: number | null; n_late: number }>(
      `SELECT AVG(CASE WHEN late THEN sleep END) AS mean_late,
              AVG(CASE WHEN NOT late THEN sleep END) AS mean_early,
              SUM(late) AS n_late
         FROM (
           SELECT date(le.eaten_at) AS d,
                  MAX(CAST(strftime('%H', le.eaten_at) AS INTEGER) >= 21) AS late,
                  (SELECT value FROM v_daily_metric m
                    WHERE m.metric = 'sleep_min'
                      AND m.log_date = date(le.eaten_at, '+1 day')) AS sleep
             FROM log_entry le
            WHERE le.status = 'resolved'
              AND date(le.eaten_at) > date(?, '-90 days')
            GROUP BY d
         ) WHERE sleep IS NOT NULL`, [today]);

    if (late && late.mean_late !== null && late.mean_early !== null && late.n_late >= 5) {
      const diff = Math.round(late.mean_late - late.mean_early);
      if (Math.abs(diff) >= 15) {
        out.push(`eating after 21:00: ${diff > 0 ? '+' : ''}${diff} min sleep `
          + `(${late.n_late} such days)`);
      }
    }
  }

  if (topic === 'stress') {
    const row = db.get<{ mean_train: number | null; mean_rest: number | null; n: number }>(
      `SELECT AVG(CASE WHEN trained THEN stress END) AS mean_train,
              AVG(CASE WHEN NOT trained THEN stress END) AS mean_rest,
              SUM(trained) AS n
         FROM (
           SELECT m.log_date, m.value AS stress,
                  EXISTS (SELECT 1 FROM workout_session ws
                           WHERE date(ws.started_at) = m.log_date) AS trained
             FROM v_daily_metric m
            WHERE m.metric = 'stress_avg' AND m.log_date > date(?, '-90 days')
         )`, [today]);
    if (row && row.mean_train !== null && row.mean_rest !== null && row.n >= 5) {
      const diff = Math.round(row.mean_train - row.mean_rest);
      if (Math.abs(diff) >= 3) {
        out.push(`training days: average stress ${diff > 0 ? '+' : ''}${diff} `
          + `(${row.n} training days)`);
      }
    }
  }

  return out;
}
