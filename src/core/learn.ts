import type { Db } from './db.ts';
import { localDate, localIso } from './clock.ts';
import { weightTrend, nutrientHabits } from './insights.ts';
import type { Decision } from './advice.ts';

/**
 * Stage 5: did it work?
 *
 * Everything before this is a report. A system that observes, explains,
 * predicts and proposes, and never checks, is a confident narrator - it
 * cannot tell advice that works from advice that merely sounds right,
 * and neither can you.
 *
 * The mechanism is falsifiability rather than cleverness. A proposal is
 * recorded only if it commits to a NUMBER and a DATE. When the date
 * arrives the same measurement is taken again and the proposal is
 * marked. A proposal that predicts nothing checkable is advice, and
 * advice is not recorded here.
 *
 * What the record is then used for is deliberately modest: it downgrades
 * the stated confidence of a kind of advice that has not worked for this
 * person. It does not silently rewrite the rules, because an application
 * whose thesis is provenance cannot start tuning itself invisibly - the
 * same reason calorie cycling is a visible weighted sum rather than a
 * fit.
 */

export type Verdict = 'worked' | 'did_not' | 'inconclusive';

/** What a decision commits to, if anything. */
export interface Prediction {
  metric: 'weight_kg_per_week' | 'protein_g_per_day' | 'fibre_g_per_day';
  value: number;
  horizonDays: number;
}

export interface OpenDecision {
  id: number;
  kind: string;
  headline: string;
  issuedAt: string;
  predictedMetric: string;
  predictedValue: number;
  baselineValue: number | null;
  horizonDays: number;
  adopted: number | null;
  dueOn: string;
}

/**
 * Record a proposal, with its commitment.
 *
 * Idempotent per kind: `ux_decision_open` allows only one unevaluated
 * proposal of each kind, so re-opening the app does not manufacture a
 * track record out of the same advice restated.
 */
export function recordDecision(
  db: Db, decision: Decision, prediction: Prediction,
  baseline: number | null, now = localIso(),
): number | null {
  const existing = db.get<{ id: number }>(
    'SELECT id FROM decision_log WHERE kind = ? AND verdict IS NULL', [decision.kind]);
  // Already standing. Restating it is not a second data point.
  if (existing) return null;

  return db.run(
    `INSERT INTO decision_log (issued_at, kind, headline, because, confidence,
                               predicted_metric, predicted_value, horizon_days,
                               baseline_value)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [now, decision.kind, decision.headline, JSON.stringify(decision.because),
     decision.confidence, prediction.metric, prediction.value,
     prediction.horizonDays, baseline],
  ).lastInsertRowid;
}

/**
 * "Did you actually do it?"
 *
 * Kept separate from the verdict, and nullable, because *unknown* is not
 * *no*. Scoring an unadopted proposal as a failure would teach the
 * system that its advice does not work when what actually happened is
 * that nobody tried it.
 */
export function markAdopted(db: Db, id: number, adopted: boolean, now = localIso()): void {
  db.run('UPDATE decision_log SET adopted = ?, acted_at = ? WHERE id = ?',
    [adopted ? 1 : 0, now, id]);
}

export function openDecisions(db: Db): OpenDecision[] {
  return db.all<any>(
    `SELECT id, kind, headline, issued_at AS issuedAt,
            predicted_metric AS predictedMetric, predicted_value AS predictedValue,
            baseline_value AS baselineValue, horizon_days AS horizonDays, adopted,
            date(issued_at, '+' || horizon_days || ' days') AS dueOn
       FROM decision_log
      WHERE verdict IS NULL
      ORDER BY dueOn`).map((r) => r as OpenDecision);
}

/**
 * Evaluate every proposal whose horizon has passed.
 *
 * Tolerance is generous on purpose. Weight moves kilograms on water, and
 * declaring a proposal failed because the rate came back at -0.36
 * instead of -0.40 would be false precision dressed as rigour.
 */
export function evaluateDue(db: Db, today = localDate()): OpenDecision[] {
  const due = openDecisions(db).filter((d) => d.dueOn <= today);
  const settled: OpenDecision[] = [];

  for (const d of due) {
    const observed = measure(db, d.predictedMetric, today);

    if (observed === null) {
      settle(db, d, null, 'inconclusive',
        'the measurement was not available when the horizon passed');
      settled.push(d);
      continue;
    }

    if (d.adopted === 0) {
      settle(db, d, observed, 'inconclusive',
        'not adopted, so the outcome says nothing about the advice');
      settled.push(d);
      continue;
    }
    if (d.adopted === null) {
      settle(db, d, observed, 'inconclusive',
        'never marked as adopted or not, so nothing can be attributed to it');
      settled.push(d);
      continue;
    }

    // Did the measurement move toward what was predicted?
    const target = d.predictedValue;
    const base = d.baselineValue;
    const tol = Math.max(Math.abs(target) * 0.25, tolerance(d.predictedMetric));

    let verdict: Verdict;
    let basis: string;
    if (Math.abs(observed - target) <= tol) {
      verdict = 'worked';
      basis = `${round(observed)} against a predicted ${round(target)}, within ${round(tol)}`;
    } else if (base !== null && Math.abs(observed - target) < Math.abs(base - target)) {
      // Moved the right way without arriving. Real, and not a success.
      verdict = 'inconclusive';
      basis = `moved from ${round(base)} to ${round(observed)}, toward ${round(target)} but short of it`;
    } else {
      verdict = 'did_not';
      basis = base === null
        ? `${round(observed)} against a predicted ${round(target)}`
        : `started at ${round(base)}, predicted ${round(target)}, came back ${round(observed)}`;
    }

    settle(db, d, observed, verdict, basis);
    settled.push(d);
  }
  return settled;
}

function settle(db: Db, d: OpenDecision, observed: number | null,
  verdict: Verdict, basis: string, now = localIso()): void {
  db.run(
    `UPDATE decision_log
        SET evaluated_at = ?, observed_value = ?, verdict = ?, verdict_basis = ?
      WHERE id = ?`, [now, observed, verdict, basis, d.id]);
}

/** Takes the same measurement the prediction committed to. */
export function measure(db: Db, metric: string, today = localDate()): number | null {
  switch (metric) {
    case 'weight_kg_per_week': {
      const t = weightTrend(db, 28, today);
      return t === null ? null : t.kgPerWeek;
    }
    case 'protein_g_per_day':
    case 'fibre_g_per_day': {
      const key = metric === 'protein_g_per_day' ? 'protein_g' : 'fibre_g';
      const h = nutrientHabits(db, 21, today).find((x) => x.nutrient === key);
      return h ? h.meanPerDay : null;
    }
    default:
      return null;
  }
}

/** Absolute tolerances, where a percentage of a near-zero target is not one. */
function tolerance(metric: string): number {
  switch (metric) {
    // 0.1 kg/week is 100 kcal/day, inside the error of food logging.
    case 'weight_kg_per_week': return 0.1;
    case 'protein_g_per_day': return 10;
    case 'fibre_g_per_day': return 4;
    default: return 0;
  }
}

export interface TrackRecord {
  kind: string;
  nEvaluated: number;
  nWorked: number;
  nDidNot: number;
  nInconclusive: number;
  /** Null until at least two conclusive verdicts exist. */
  hitRate: number | null;
  basis: string;
}

export function trackRecord(db: Db): TrackRecord[] {
  return db.all<any>('SELECT * FROM v_advice_track_record ORDER BY kind').map((r) => {
    const conclusive = r.n_worked + r.n_did_not;
    return {
      kind: r.kind,
      nEvaluated: r.n_evaluated,
      nWorked: r.n_worked,
      nDidNot: r.n_did_not,
      nInconclusive: r.n_inconclusive,
      hitRate: conclusive >= 2 ? Number((r.n_worked / conclusive).toFixed(2)) : null,
      basis: `${r.n_worked} worked, ${r.n_did_not} did not, `
        + `${r.n_inconclusive} inconclusive`,
    };
  });
}

/**
 * How much to trust a kind of advice, given how it has gone before.
 *
 * Only ever downgrades. Advice that happened to work three times is not
 * thereby more reliable - three successes on this sample size is what
 * chance looks like - but advice that has repeatedly failed for this
 * person is evidence about this person, and continuing to state it
 * confidently would be the system refusing to learn.
 */
export function temperConfidence(
  stated: Decision['confidence'], record: TrackRecord | undefined,
): { confidence: Decision['confidence']; note: string | null } {
  if (!record || record.hitRate === null) return { confidence: stated, note: null };
  if (record.hitRate >= 0.5) return { confidence: stated, note: null };

  const down: Record<string, Decision['confidence']> = {
    high: 'medium', medium: 'low', low: 'low',
  };
  return {
    confidence: down[stated],
    note: `this kind of advice has not worked for you before (${record.basis})`,
  };
}

const round = (v: number) => Number(v.toFixed(2));
