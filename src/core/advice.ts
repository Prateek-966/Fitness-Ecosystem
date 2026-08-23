import type { Db } from './db.ts';
import { localDate } from './clock.ts';
import { baselines, dayInputs, scoreDay } from './cycling.ts';
import {
  energyBalance, foodHabits, nutrientHabits, trainingDayIntake, weightTrend,
  type NutrientHabit,
} from './insights.ts';
import { temperConfidence, trackRecord, type Prediction } from './learn.ts';

/**
 * "Given my goal, my state, my history and what I actually eat, what is
 * the best decision I can make right now?"
 *
 * OWNER-AUTHORISED. CLAUDE.md lists a recommendation engine among the
 * things deliberately absent, and this is one. It was asked for
 * directly. Recorded here so it is not later removed by someone
 * enforcing that list in good faith.
 *
 * HOW IT IS ALLOWED TO WORK. This application's entire claim is that it
 * is honest about where numbers come from, so its most consequential
 * output cannot be a black box. There is no model here and no network
 * call: it is a transparent rule set over facts already in the
 * database, and every recommendation carries the figures that produced
 * it. Exactly the reasoning that made calorie cycling a weighted sum
 * rather than a fit - and the same reasoning means this file gets
 * REPLACED, not extended, once the adaptive TDEE model exists and can
 * answer the maintenance question properly.
 *
 * THE ONE RULE WORTH STATING OUTRIGHT. When the scale says "push
 * harder" and the body says "do not", the body wins for today and
 * composition becomes the lever instead. You cannot out-deficit poor
 * recovery, and deepening a deficit into short sleep and falling HRV is
 * the single most common way a plan stops working. Protein and fibre
 * can be fixed without spending a calorie.
 */

export type Confidence = 'high' | 'medium' | 'low';

export type DecisionKind = 'energy' | 'recovery' | 'composition' | 'data' | 'consistency';

export interface Decision {
  /** What to do, in one line. */
  headline: string;
  /** The figures it came from. Never prose alone. */
  because: string[];
  confidence: Confidence;
  /** Why the confidence is what it is - usually how much data there was. */
  confidenceBasis: string;
  kind: DecisionKind;
  /**
   * What this commits to, so stage 5 can check it later. Absent means
   * the decision predicts nothing measurable - which is allowed, and
   * means it is never written to the decision log.
   */
  predicts?: Prediction;
  /** Set when the track record has lowered the stated confidence. */
  temperedBy?: string;
}

export interface Situation {
  today: string;
  decisions: Decision[];
  /** True when there is not yet enough data to say anything useful. */
  provisional: boolean;
}

/** The published figure the goal screens are pinned to. */
const KCAL_PER_KG = 7000;

/** Below this r-squared the weight series is noise, not a trend. */
const TREND_FIT_FLOOR = 0.3;

export function decide(db: Db, today = localDate()): Situation {
  const decisions: Decision[] = [];

  const trend = weightTrend(db, 28, today);
  const balance = energyBalance(db, 28, today);
  const habits = nutrientHabits(db, 28, today);
  const goal = db.get<{ goal_weight_kg: number | null; goal_rate_kg_per_week: number; weight_kg: number }>(
    `SELECT goal_weight_kg, goal_rate_kg_per_week, weight_kg
       FROM body_profile ORDER BY recorded_at DESC, id DESC LIMIT 1`);

  // Recovery first, because it gates what the energy advice is allowed
  // to say.
  const recovery = recoveryState(db, today);
  if (recovery) decisions.push(recovery.decision);

  const energy = energyDecision(trend, balance, goal, recovery?.strained ?? false);
  if (energy) decisions.push(energy);

  decisions.push(...compositionDecisions(db, habits, today));

  const consistency = consistencyDecision(db, today);
  if (consistency) decisions.push(consistency);

  const gaps = dataGaps(db, trend, balance, today);
  decisions.push(...gaps);

  // Stage 5 feeding back into stage 4. Only ever downward: advice that
  // has repeatedly failed for this person is evidence about this
  // person, while advice that happened to work three times is what
  // chance looks like at this sample size.
  const record = new Map(trackRecord(db).map((r) => [r.kind, r]));
  for (const d of decisions) {
    const { confidence, note } = temperConfidence(d.confidence, record.get(d.kind));
    d.confidence = confidence;
    if (note) d.temperedBy = note;
  }

  return {
    today,
    // Anything resting on fewer than fourteen logged days is a guess
    // wearing a number.
    provisional: balance.nDays < 14 || trend === null,
    decisions,
  };
}

// ------------------------------------------------------------------

interface Recovery { decision: Decision; strained: boolean }

/**
 * Today's physiology against your own rolling baseline, reusing the
 * scorer the calorie plan already uses so the two can never disagree
 * about whether today was hard.
 */
function recoveryState(db: Db, today: string): Recovery | null {
  const day = dayInputs(db, today);
  const base = baselines(db, today);
  if (day.sleepMin === null && day.hrvMs === null && day.sessionKcal === 0) return null;

  const { weight, reasons } = scoreDay(day, base);
  // scoreDay returns >1 when the day argues for eating MORE - it is
  // built to raise intake on hard and poorly-recovered days.
  const strained = weight > 1.05;

  return {
    strained,
    decision: {
      kind: 'recovery',
      headline: strained
        ? 'Do not deepen the deficit today — hold, or eat at maintenance'
        : 'Recovery looks fine; today can carry a normal deficit',
      because: reasons,
      confidence: base.sleepMin === null || base.hrvMs === null ? 'low' : 'medium',
      confidenceBasis: base.sleepMin === null
        ? 'no personal baseline yet — these are single readings with nothing to compare against'
        : 'compared against your own 28-day baseline, not a population norm',
    },
  };
}

/**
 * Trend against intended rate — and, crucially, against what the log
 * says should have happened.
 */
function energyDecision(
  trend: ReturnType<typeof weightTrend>,
  balance: ReturnType<typeof energyBalance>,
  goal: { goal_weight_kg: number | null; goal_rate_kg_per_week: number; weight_kg: number } | undefined,
  strained: boolean,
): Decision | null {
  if (!trend || !goal) return null;

  const wanted = goal.goal_rate_kg_per_week;
  if (wanted === 0) return null;

  const shortfallKgWeek = wanted - trend.kgPerWeek;      // negative rate: losing
  const kcalPerDay = Math.round((shortfallKgWeek * KCAL_PER_KG) / 7);
  const onTrack = Math.abs(shortfallKgWeek) < 0.1;

  const because = [
    `losing ${Math.abs(trend.kgPerWeek)} kg/week, aiming for ${Math.abs(wanted)}`,
    `from ${trend.basis}`,
  ];
  if (goal.goal_weight_kg !== null) {
    because.push(`${Math.abs(goal.weight_kg - goal.goal_weight_kg).toFixed(1)} kg from ${goal.goal_weight_kg} kg`);
  }

  // The disagreement between the log and the scale is the most useful
  // thing here, so it is surfaced rather than resolved by fiat.
  if (balance.gapKcal !== null && balance.impliedGapKcal !== null) {
    const disagreement = Math.abs(balance.gapKcal - balance.impliedGapKcal);
    if (disagreement > 300) {
      return {
        kind: 'energy',
        headline: 'Your log and your scale disagree — trust neither number until that is resolved',
        because: [
          `log says ${balance.gapKcal > 0 ? '+' : ''}${balance.gapKcal} kcal/day against target`,
          `scale says ${balance.impliedGapKcal > 0 ? '+' : ''}${balance.impliedGapKcal} kcal/day`,
          `a gap of ${Math.round(disagreement)} kcal/day is too large to be measurement noise`,
        ],
        confidence: 'medium',
        confidenceBasis: 'either the logging is drifting or the target is wrong; '
          + 'daily_logging_stats is what tells those two apart',
      };
    }
  }

  if (onTrack) {
    return {
      kind: 'energy',
      headline: 'On track — change nothing',
      because,
      confidence: trend.r2 >= TREND_FIT_FLOOR ? 'high' : 'low',
      confidenceBasis: `weight series fits a line at r²=${trend.r2}`,
    };
  }

  // Losing slower than intended. The obvious move is a deeper deficit,
  // and it is the wrong one when recovery is already strained.
  if (strained) {
    return {
      kind: 'energy',
      headline: `Hold the current intake — the ${Math.abs(kcalPerDay)} kcal/day shortfall is not today's problem`,
      // A claim, and therefore checkable: if recovery was the blocker,
      // the rate should improve without cutting anything.
      predicts: { metric: 'weight_kg_per_week', value: wanted, horizonDays: 28 },
      because: [
        ...because,
        'recovery signals are down, and a deeper deficit into that usually stalls the loss rather than restarting it',
      ],
      confidence: 'medium',
      confidenceBasis: 'the arithmetic is sound; whether recovery is the cause is inference, not measurement',
    };
  }

  return {
    kind: 'energy',
    headline: `Take about ${Math.abs(kcalPerDay)} kcal/day off to reach ${Math.abs(wanted)} kg/week`,
    // The falsifiable part. Three weeks is short enough to act on and
    // long enough that water weight has stopped dominating.
    predicts: { metric: 'weight_kg_per_week', value: wanted, horizonDays: 21 },
    because,
    confidence: trend.r2 >= TREND_FIT_FLOOR ? 'medium' : 'low',
    confidenceBasis: trend.r2 >= TREND_FIT_FLOOR
      ? `weight series fits a line at r²=${trend.r2}`
      : `weight series barely fits a line (r²=${trend.r2}) — weigh more often before acting on this`,
  };
}

/**
 * Composition, which is the lever that costs nothing.
 *
 * Suggestions name foods from your own log rather than an ideal diet:
 * advice to eat something you have never eaten is advice you will not
 * take, and this application has never had an opinion about what food
 * is good.
 */
function compositionDecisions(db: Db, habits: NutrientHabit[], today: string): Decision[] {
  const out: Decision[] = [];
  const byName = new Map(habits.map((h) => [h.nutrient, h]));

  for (const [nutrient, label] of [['protein_g', 'protein'], ['fibre_g', 'fibre']] as const) {
    const h = byName.get(nutrient);
    if (!h || h.adherence === null || h.adherence >= 0.85) continue;

    const richest = denseFoods(db, nutrient, today);
    const because = [
      `${Math.round(h.meanPerDay)} g/day against a ${Math.round(h.targetPerDay!)} g target`,
      h.basis,
    ];
    if (richest.length) {
      because.push(`densest ${label} in your own log: ${richest.map((f) => f.name).join(', ')}`);
    }

    out.push({
      kind: 'composition',
      headline: richest.length
        ? `Raise ${label} without adding calories — more ${richest[0].name}, less of something else`
        : `Raise ${label}: you are at ${Math.round((h.adherence) * 100)}% of target`,
      predicts: {
        metric: nutrient === 'protein_g' ? 'protein_g_per_day' : 'fibre_g_per_day',
        // Meeting the target outright in three weeks is not realistic;
        // closing most of the gap is.
        value: Math.round(h.meanPerDay + (h.targetPerDay! - h.meanPerDay) * 0.7),
        horizonDays: 21,
      },
      because,
      confidence: h.nDays >= 14 ? 'high' : 'low',
      confidenceBasis: `${h.nDays} logged days`,
    });
  }
  return out;
}

/** Foods you already eat, ranked by how much of a nutrient they carry. */
function denseFoods(db: Db, nutrient: string, today: string, limit = 3):
Array<{ name: string; per100g: number }> {
  const eaten = foodHabits(db, 56, 40, today);
  if (!eaten.length) return [];
  const ids = eaten.map((f) => f.foodId);
  return db.all<{ name: string; per100g: number }>(
    `SELECT f.name AS name, fn.per_100g AS per100g
       FROM food_nutrient fn JOIN food f ON f.id = fn.food_id
      WHERE fn.nutrient = ? AND fn.food_id IN (${ids.map(() => '?').join(',')})
      ORDER BY fn.per_100g DESC LIMIT ?`,
    [nutrient, ...ids, limit],
  );
}

/**
 * Whether the logging itself is holding up. A recommendation built on a
 * week that was half-logged is worse than no recommendation, because it
 * looks the same as a good one.
 */
function consistencyDecision(db: Db, today: string): Decision | null {
  const row = db.get<{ n: number; eligible: number; mean_weighed: number | null }>(
    `SELECT COUNT(*) AS n,
            SUM(model_eligible) AS eligible,
            AVG(weighed_fraction) AS mean_weighed
       FROM daily_logging_stats
      WHERE log_date > date(?, '-28 days') AND log_date <= ?`, [today, today]);
  if (!row || row.n < 7) return null;

  const eligibleShare = row.eligible / row.n;
  if (eligibleShare >= 0.7) return null;

  return {
    kind: 'consistency',
    headline: 'Fix the logging before changing the plan',
    because: [
      `only ${row.eligible} of the last ${row.n} logged days are clean enough to reason from`,
      row.mean_weighed !== null
        ? `${Math.round(row.mean_weighed * 100)}% of entries resolved from a weighed measure`
        : 'no weighed-measure figure yet',
    ],
    confidence: 'high',
    confidenceBasis: 'measured directly, not inferred',
  };
}

/** What is missing, said plainly rather than worked around. */
function dataGaps(
  db: Db, trend: ReturnType<typeof weightTrend>,
  balance: ReturnType<typeof energyBalance>, today: string,
): Decision[] {
  const out: Decision[] = [];

  if (trend === null) {
    out.push({
      kind: 'data',
      headline: 'Weigh yourself more often — there is no trend to reason from yet',
      because: ['fewer than three weight readings in the last 28 days',
        'daily weight moves kilograms on water alone, so a rate needs a series, not two points'],
      confidence: 'high',
      confidenceBasis: 'counted directly',
    });
  }

  if (balance.nDays < 14) {
    out.push({
      kind: 'data',
      headline: `Keep logging — ${balance.nDays} of the last 28 days are logged`,
      because: ['under fourteen days, an average is a guess wearing a number'],
      confidence: 'high',
      confidenceBasis: 'counted directly',
    });
  }

  const split = trainingDayIntake(db, 28, today);
  if (split.nOn > 0 && split.nOff > 0 && split.differenceKcal !== null
      && Math.abs(split.differenceKcal) < 100) {
    out.push({
      kind: 'energy',
      headline: 'You eat the same on training days as on rest days',
      because: [
        `${split.onKcal} kcal trained vs ${split.offKcal} kcal rest`,
        split.basis,
        'the weekly total is what matters, so this is an observation rather than a fault',
      ],
      confidence: split.nOn >= 4 ? 'medium' : 'low',
      confidenceBasis: split.basis,
    });
  }

  return out;
}
