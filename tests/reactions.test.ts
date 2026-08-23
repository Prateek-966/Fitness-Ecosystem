import { beforeEach, describe, expect, it } from 'vitest';
import { addFood, freshDb, unitId } from './helpers';
import type { Db } from '../src/core/db';
import { foodReactions, wellbeingAdvice } from '../src/core/reactions';

/**
 * The most important test in this file is the one where the app finds
 * NOTHING.
 *
 * Test forty foods against sleep and about two will look significant
 * from noise alone. A version of this feature without correction would
 * announce that paneer ruins your sleep, the owner would stop eating
 * paneer, and the app would have made him worse off while sounding
 * scientific. So the negative case is pinned first.
 */

let db: Db;
const TODAY = '2026-08-23';

const dayBefore = (n: number): string => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const eat = (food: number, date: string, hour = 13) =>
  db.run(`INSERT INTO log_entry (eaten_at, food_id, quantity, unit_id, grams_resolved,
                                 status, meal_slot, created_at)
          VALUES (?,?,1,?,150,'resolved',?,?)`,
    [`${date}T${String(hour).padStart(2, '0')}:00:00`, food, unitId(db, 'g'),
     hour >= 20 ? 'dinner' : 'lunch', `${date}T13:00:00`]);

const metric = (date: string, key: string, value: number) =>
  db.run(`INSERT INTO daily_metric (log_date, metric, value, source, recorded_at)
          VALUES (?,?,?,'garmin',?)`, [date, key, value, `${date}T08:00:00`]);

/** A deterministic pseudo-random sequence, so the test cannot flake. */
function noise(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

beforeEach(() => { db = freshDb(); });

describe('it does not find things that are not there', () => {
  it('reports nothing notable when food and sleep are unrelated', () => {
    // Twelve foods eaten on arbitrary days, sleep generated with no
    // reference to any of them. Anything flagged here is a false
    // positive by construction.
    const rnd = noise(7);
    const foods = Array.from({ length: 12 }, (_, i) => addFood(db, `Food ${i}`, 100));
    for (let d = 89; d >= 0; d--) {
      const day = dayBefore(d);
      metric(day, 'sleep_min', 380 + Math.round(rnd() * 120));
      for (const f of foods) if (rnd() < 0.4) eat(f, day, 20);
    }

    const { reactions, nTested } = foodReactions(db, { metric: 'sleep_min' }, TODAY);
    expect(nTested).toBeGreaterThanOrEqual(10);
    expect(reactions.filter((r) => r.notable)).toEqual([]);
  });

  it('states how many comparisons it made', () => {
    // A reader who cannot see how many questions were asked cannot
    // judge the one they are shown.
    const rnd = noise(11);
    for (let i = 0; i < 8; i++) {
      const f = addFood(db, `Food ${i}`, 100);
      for (let d = 60; d >= 0; d--) if (rnd() < 0.5) eat(f, dayBefore(d), 20);
    }
    for (let d = 60; d >= 0; d--) metric(dayBefore(d), 'sleep_min', 400 + Math.round(rnd() * 60));

    const { caveat, nTested } = foodReactions(db, { metric: 'sleep_min' }, TODAY);
    expect(nTested).toBe(8);
    expect(caveat).toContain('8 foods tested');
    expect(caveat).toContain('associations, not causes');
  });

  it('refuses to compare on an anecdote', () => {
    const f = addFood(db, 'Biryani', 200);
    eat(f, dayBefore(3), 21);
    for (let d = 30; d >= 0; d--) metric(dayBefore(d), 'sleep_min', 420);
    // One night is not a comparison.
    expect(foodReactions(db, { metric: 'sleep_min', minDaysEach: 5 }, TODAY).nTested).toBe(0);
  });

  it('says so plainly when there is barely any data', () => {
    const f = addFood(db, 'Dal', 116);
    eat(f, dayBefore(1), 20);
    metric(dayBefore(0), 'sleep_min', 400);
    const { caveat, reactions } = foodReactions(db, { metric: 'sleep_min' }, TODAY);
    expect(reactions).toEqual([]);
    expect(caveat).toMatch(/not enough data yet/);
  });
});

describe('it does find a real effect', () => {
  it('detects a strong, consistent association and survives correction', () => {
    // 70 minutes less sleep, every time, for 90 days. If this does not
    // clear the bar, the bar is in the wrong place.
    const culprit = addFood(db, 'Late biryani', 200);
    const innocent = addFood(db, 'Dal', 116);
    const rnd = noise(3);

    for (let d = 89; d >= 0; d--) {
      const day = dayBefore(d);
      const ate = d % 3 === 0;
      if (ate) eat(culprit, day, 21);
      if (rnd() < 0.5) eat(innocent, day, 13);
      // Sleep measured the MORNING AFTER, hence the +1 day offset.
      metric(shift(day, 1), 'sleep_min',
        (ate ? 350 : 420) + Math.round(rnd() * 20));
    }

    const { reactions } = foodReactions(db, { metric: 'sleep_min' }, TODAY);
    const found = reactions.find((r) => r.food === 'Late biryani')!;
    expect(found.notable).toBe(true);
    expect(found.difference).toBeLessThan(-50);
    expect(found.pAdjusted).toBeLessThan(0.05);

    // And the innocent food stays innocent.
    expect(reactions.find((r) => r.food === 'Dal')!.notable).toBe(false);
  });

  it('gives the same answer twice on the same data', () => {
    // The permutation shuffle is seeded for exactly this reason: an
    // app that says paneer is fine on Monday and suspect on Tuesday,
    // from identical data, is worse than one that says nothing.
    const f = addFood(db, 'Late biryani', 200);
    const rnd = noise(5);
    for (let d = 89; d >= 0; d--) {
      const day = dayBefore(d);
      const ate = d % 3 === 0;
      if (ate) eat(f, day, 21);
      metric(shift(day, 1), 'sleep_min', (ate ? 350 : 420) + Math.round(rnd() * 20));
    }
    const a = foodReactions(db, { metric: 'sleep_min' }, TODAY);
    const b = foodReactions(db, { metric: 'sleep_min' }, TODAY);
    expect(a.reactions).toEqual(b.reactions);
  });

  it('knows which direction is the good one, per metric', () => {
    const f = addFood(db, 'Chai', 40);
    const rnd = noise(9);
    for (let d = 89; d >= 0; d--) {
      const day = dayBefore(d);
      const ate = d % 2 === 0;
      if (ate) eat(f, day, 20);
      metric(day, 'stress_avg', (ate ? 48 : 28) + Math.round(rnd() * 5));
    }
    const advice = wellbeingAdvice(db, 'stress', TODAY);
    // Higher stress is not what you want, and the wording must say so.
    expect(advice.findings.join(' ')).toMatch(/direction you do not/);
  });
});

describe('what it hands back', () => {
  it('returns hypotheses to test, not instructions to follow', () => {
    const f = addFood(db, 'Late biryani', 200);
    const rnd = noise(13);
    for (let d = 89; d >= 0; d--) {
      const day = dayBefore(d);
      const ate = d % 3 === 0;
      if (ate) eat(f, day, 21);
      metric(shift(day, 1), 'sleep_min', (ate ? 340 : 425) + Math.round(rnd() * 20));
    }

    const advice = wellbeingAdvice(db, 'sleep', TODAY);
    expect(advice.headline).toMatch(/worth testing/);
    expect(advice.hypotheses[0].food).toBe('Late biryani');
    expect(advice.caveat).toMatch(/Association is not cause/);
    expect(advice.caveat).toMatch(/test deliberately, not as rules/);
  });

  it('says nothing rather than something when nothing is there', () => {
    const rnd = noise(17);
    for (let i = 0; i < 6; i++) {
      const f = addFood(db, `Food ${i}`, 100);
      for (let d = 89; d >= 0; d--) if (rnd() < 0.5) eat(f, dayBefore(d), 20);
    }
    for (let d = 89; d >= 0; d--) metric(dayBefore(d), 'sleep_min', 400 + Math.round(rnd() * 80));

    const advice = wellbeingAdvice(db, 'sleep', TODAY);
    expect(advice.hypotheses).toEqual([]);
    expect(advice.headline).toMatch(/beyond chance/);
  });

  it('surfaces the behavioural lever, which is usually the bigger one', () => {
    // Eating after 21:00 costs an hour of sleep here. No single food
    // explains it, and the app should still say it.
    const f = addFood(db, 'Dinner', 150);
    for (let d = 89; d >= 0; d--) {
      const day = dayBefore(d);
      const late = d % 2 === 0;
      eat(f, day, late ? 22 : 18);
      metric(shift(day, 1), 'sleep_min', late ? 360 : 420);
    }
    const advice = wellbeingAdvice(db, 'sleep', TODAY);
    expect(advice.findings.join(' ')).toMatch(/eating after 21:00/);
  });

  it('does not volunteer anything — it only answers when asked', () => {
    // Principle 8. There is no scheduler, no trigger and no push here;
    // the only entry points are these two functions.
    const src = new URL('../src/core/reactions.ts', import.meta.url);
    const text = require('node:fs').readFileSync(src, 'utf8');
    expect(text).not.toMatch(/setInterval|setTimeout|notif/i);
  });
});

function shift(date: string, byDays: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + byDays);
  return d.toISOString().slice(0, 10);
}
