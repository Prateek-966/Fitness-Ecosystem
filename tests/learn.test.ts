import { beforeEach, describe, expect, it } from 'vitest';
import { addFood, freshDb, unitId } from './helpers';
import type { Db } from '../src/core/db';
import { decide } from '../src/core/advice';
import {
  evaluateDue, markAdopted, measure, openDecisions, recordDecision,
  temperConfidence, trackRecord,
} from '../src/core/learn';
import { goalArrival, project } from '../src/core/insights';

/**
 * Stages 3 and 5 of the owner's ladder - predict, and learn.
 *
 * Everything before the last stage is a report. This file is what makes
 * it a loop: a proposal that commits to a number and a date, checked
 * when the date arrives, and a track record that can tell advice which
 * works from advice which merely sounds right.
 */

let db: Db;
let rice: number;
const TODAY = '2026-08-23';

const dayBefore = (n: number): string => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const weigh = (date: string, kg: number) =>
  db.run(`INSERT INTO body_profile (recorded_at, sex, age_years, height_cm, weight_kg,
                                    activity_factor, goal_rate_kg_per_week, goal_weight_kg)
          VALUES (?,'male',34,178,?,1.465,-0.4,72)`, [`${date}T07:00:00`, kg]);

const eat = (date: string, grams: number) =>
  db.run(`INSERT INTO log_entry (eaten_at, food_id, quantity, unit_id, grams_resolved,
                                 status, created_at)
          VALUES (?,?,1,?,?,'resolved',?)`,
    [`${date}T13:00:00`, rice, unitId(db, 'g'), grams, `${date}T13:00:00`]);

beforeEach(() => {
  db = freshDb();
  rice = addFood(db, 'Rice, cooked', 130);
});

// ------------------------------------------------------------------
describe('stage 3: if you continue like this', () => {
  it('projects an interval, never a point', () => {
    // A rate of -0.32 +/- 0.05 and one of -0.32 +/- 0.40 are the same
    // number and completely different facts.
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + (i * 0.32) / 7);

    const p = project(db, 8, TODAY)!;
    expect(p.kg).toBeCloseTo(75.4 - 0.32 * 8, 1);
    expect(p.lowKg).toBeLessThanOrEqual(p.kg);
    expect(p.highKg).toBeGreaterThanOrEqual(p.kg);
    expect(p.basis).toMatch(/\+\/-/);
  });

  it('widens the interval the further out it goes', () => {
    // Being unsure of a slope costs more the further you extrapolate.
    // A long projection should look as useless as it is.
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + (i % 4) * 0.4 + (i * 0.3) / 7);

    const near = project(db, 4, TODAY)!;
    const far = project(db, 26, TODAY)!;
    expect(far.highKg - far.lowKg).toBeGreaterThan(near.highKg - near.lowKg);
  });

  it('separates when you arrive at the rate you are going from the rate you asked for', () => {
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + (i * 0.2) / 7);

    const a = goalArrival(db, TODAY)!;
    expect(a.goalKg).toBe(72);
    // 3.4 kg at 0.2/week is 17 weeks; at the intended 0.4 it is 8.5.
    expect(a.weeksAtCurrentRate).toBeCloseTo(17, 0);
    expect(a.weeksAtIntendedRate).toBeCloseTo(8.5, 1);
    expect(a.movingAway).toBe(false);
  });

  it('says plainly when you are going the wrong way', () => {
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 - (i * 0.3) / 7);
    expect(goalArrival(db, TODAY)!.movingAway).toBe(true);
    expect(goalArrival(db, TODAY)!.weeksAtCurrentRate).toBeNull();
  });
});

// ------------------------------------------------------------------
describe('stage 5: did it work', () => {
  const proposal = {
    kind: 'energy' as const,
    headline: 'Take about 250 kcal/day off',
    because: ['losing 0.15 kg/week, aiming for 0.4'],
    confidence: 'medium' as const,
    confidenceBasis: 'r²=0.9',
  };
  const commitment = {
    metric: 'weight_kg_per_week' as const, value: -0.4, horizonDays: 21,
  };

  it('records a proposal with a number and a date', () => {
    const id = recordDecision(db, proposal, commitment, -0.15, `${dayBefore(21)}T09:00:00`);
    expect(id).not.toBeNull();
    const open = openDecisions(db);
    expect(open).toHaveLength(1);
    expect(open[0].dueOn).toBe(TODAY);
  });

  it('will not restate the same open proposal as a second data point', () => {
    // Re-opening the app every day for a week would otherwise
    // manufacture a track record out of one piece of advice.
    recordDecision(db, proposal, commitment, -0.15, `${dayBefore(21)}T09:00:00`);
    expect(recordDecision(db, proposal, commitment, -0.15, `${dayBefore(20)}T09:00:00`)).toBeNull();
    expect(openDecisions(db)).toHaveLength(1);
  });

  it('marks it worked when the measurement arrives where predicted', () => {
    const id = recordDecision(db, proposal, commitment, -0.15, `${dayBefore(21)}T09:00:00`)!;
    markAdopted(db, id, true);
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + (i * 0.4) / 7);

    evaluateDue(db, TODAY);
    const row = db.get<any>('SELECT verdict, verdict_basis, observed_value FROM decision_log');
    expect(row.verdict).toBe('worked');
    expect(row.observed_value).toBeCloseTo(-0.4, 1);
  });

  it('marks it failed when nothing moved', () => {
    const id = recordDecision(db, proposal, commitment, -0.15, `${dayBefore(21)}T09:00:00`)!;
    markAdopted(db, id, true);
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + (i * 0.15) / 7);

    evaluateDue(db, TODAY);
    const row = db.get<any>('SELECT verdict, verdict_basis FROM decision_log');
    expect(row.verdict).toBe('did_not');
    expect(row.verdict_basis).toMatch(/started at .*predicted .*came back/);
  });

  it('calls partial movement inconclusive, not success', () => {
    // Moving the right way without arriving is real, and it is not a
    // success. Scoring it either way would be a lie in one direction.
    const id = recordDecision(db, proposal, commitment, -0.15, `${dayBefore(21)}T09:00:00`)!;
    markAdopted(db, id, true);
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + (i * 0.28) / 7);

    evaluateDue(db, TODAY);
    expect(db.get<any>('SELECT verdict FROM decision_log').verdict).toBe('inconclusive');
  });

  it('never blames the advice for something you did not do', () => {
    // The single most important rule here. Scoring an unadopted
    // proposal as a failure teaches the system that its advice does not
    // work, when what happened is that nobody tried it.
    const id = recordDecision(db, proposal, commitment, -0.15, `${dayBefore(21)}T09:00:00`)!;
    markAdopted(db, id, false);
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + (i * 0.15) / 7);

    evaluateDue(db, TODAY);
    const row = db.get<any>('SELECT verdict, verdict_basis FROM decision_log');
    expect(row.verdict).toBe('inconclusive');
    expect(row.verdict_basis).toMatch(/not adopted/);
  });

  it('treats unknown adoption as unknown, not as no', () => {
    recordDecision(db, proposal, commitment, -0.15, `${dayBefore(21)}T09:00:00`);
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + (i * 0.4) / 7);
    evaluateDue(db, TODAY);
    expect(db.get<any>('SELECT verdict FROM decision_log').verdict).toBe('inconclusive');
  });

  it('does not evaluate before the horizon has passed', () => {
    recordDecision(db, proposal, commitment, -0.15, `${dayBefore(3)}T09:00:00`);
    expect(evaluateDue(db, TODAY)).toHaveLength(0);
    expect(openDecisions(db)).toHaveLength(1);
  });

  it('is inconclusive when the measurement is simply unavailable', () => {
    const id = recordDecision(db, proposal, commitment, -0.15, `${dayBefore(21)}T09:00:00`)!;
    markAdopted(db, id, true);
    evaluateDue(db, TODAY);           // no weight readings at all
    expect(db.get<any>('SELECT verdict_basis FROM decision_log').verdict_basis)
      .toMatch(/not available/);
  });
});

// ------------------------------------------------------------------
describe('the loop closing: what the record is used for', () => {
  const settle = (kind: string, verdict: string, n: number) => {
    for (let i = 0; i < n; i++) {
      db.run(
        `INSERT INTO decision_log (issued_at, kind, headline, because, confidence,
                                   predicted_metric, predicted_value, horizon_days,
                                   evaluated_at, verdict)
         VALUES (?,?,?,'[]','medium','weight_kg_per_week',-0.4,21,?,?)`,
        [`${dayBefore(60 - i)}T09:00:00`, kind, `advice ${i}`,
         `${dayBefore(40 - i)}T09:00:00`, verdict]);
    }
  };

  it('downgrades advice that has repeatedly failed for this person', () => {
    settle('energy', 'did_not', 3);
    const record = trackRecord(db).find((r) => r.kind === 'energy')!;
    expect(record.hitRate).toBe(0);

    const { confidence, note } = temperConfidence('high', record);
    expect(confidence).toBe('medium');
    expect(note).toMatch(/has not worked for you before/);
  });

  it('does not promote advice that happened to work', () => {
    // Three successes at this sample size is what chance looks like.
    settle('energy', 'worked', 3);
    const record = trackRecord(db).find((r) => r.kind === 'energy')!;
    expect(temperConfidence('medium', record).confidence).toBe('medium');
  });

  it('withholds a hit rate until there are conclusive verdicts to rate', () => {
    settle('energy', 'inconclusive', 5);
    expect(trackRecord(db).find((r) => r.kind === 'energy')!.hitRate).toBeNull();
    expect(temperConfidence('high', trackRecord(db)[0]).confidence).toBe('high');
  });

  it('shows up in the advice itself, with the reason attached', () => {
    settle('energy', 'did_not', 4);
    for (let i = 27; i >= 0; i--) {
      weigh(dayBefore(i), 75.4 + (i * 0.15) / 7);
      eat(dayBefore(i), 1292);
      db.run(`INSERT INTO energy_target (log_date, source, kcal, computed_at)
              VALUES (?,'manual',2000,?)`, [dayBefore(i), `${dayBefore(i)}T00:00:00`]);
    }

    const energy = decide(db, TODAY).decisions.find((d) => d.kind === 'energy')!;
    expect(energy.temperedBy).toMatch(/has not worked for you before/);
    expect(energy.confidence).toBe('low');
  });
});

// ------------------------------------------------------------------
describe('what a decision commits to', () => {
  it('a prescribed cut commits to a rate and a date', () => {
    for (let i = 27; i >= 0; i--) {
      weigh(dayBefore(i), 75.4 + (i * 0.15) / 7);
      eat(dayBefore(i), 1292);
      db.run(`INSERT INTO energy_target (log_date, source, kcal, computed_at)
              VALUES (?,'manual',2000,?)`, [dayBefore(i), `${dayBefore(i)}T00:00:00`]);
    }
    const energy = decide(db, TODAY).decisions.find((d) => d.kind === 'energy')!;
    expect(energy.predicts).toEqual({
      metric: 'weight_kg_per_week', value: -0.4, horizonDays: 21,
    });
  });

  it('advice that predicts nothing checkable commits to nothing', () => {
    // And is therefore never written to the decision log, because a
    // track record made of unfalsifiable claims is decoration.
    const gaps = decide(db, TODAY).decisions.filter((d) => d.kind === 'data');
    expect(gaps.length).toBeGreaterThan(0);
    for (const d of gaps) expect(d.predicts).toBeUndefined();
  });

  it('measures the same quantity it predicted', () => {
    for (let i = 27; i >= 0; i--) weigh(dayBefore(i), 75.4 + (i * 0.4) / 7);
    expect(measure(db, 'weight_kg_per_week', TODAY)).toBeCloseTo(-0.4, 1);
    expect(measure(db, 'nonsense', TODAY)).toBeNull();
  });
});
