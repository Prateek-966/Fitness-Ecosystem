/**
 * Resolution pipeline: utterance -> log_entry.
 *
 * The contract:
 *   - The utterance is written FIRST, unconditionally. Nothing below can
 *     lose it.
 *   - Food identity must be unambiguous before anything reaches log_entry.
 *   - Quantity may be absent. That is 'pending_quantity', not ambiguity.
 *   - Every resolution can write back to phrase_index, so the next one is
 *     free.
 *
 * Threshold note: the two failure modes are NOT symmetric.
 *   false negative -> slow path. Annoying, self-correcting.
 *   false positive -> silently logs the wrong food. You never catch it.
 * Start conservative. Loosen only after auditing real match_score data
 * in v_match_review.
 */

import type { Db } from './db';
import { parse, type ParsedItem } from './parse';
import { bestMatch, type Candidate } from './similarity';
import { getSetting } from './settings';

export type MatchMethod = 'exact_index' | 'fuzzy_index' | 'llm_resolved' | 'manual';
export type PendingReason = 'quantity_missing' | 'unit_missing' | 'unit_uncalibrated';

export interface Resolution {
  foodId: number;
  quantity: number | null;
  unitId: number | null;
  matchMethod: MatchMethod;
  matchScore: number;
  needsUser: boolean;
  reason: PendingReason | null;
  /** Diagnostics for match_audit. */
  chosenPhrase: string | null;
  runnerUp: string | null;
  runnerUpScore: number | null;
  threshold: number;
}

interface IndexRow {
  id: number;
  phrase: string;
  food_id: number;
  default_qty: number | null;
  default_unit_id: number | null;
}

export interface CaptureInput {
  rawText: string;
  sttConfidence?: number | null;
  spokenAt: Date;
  tzOffsetMin: number;
  audioPath?: string | null;
}

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------
// Step 0 — capture. Never fails, never blocks, never waits on network.
// This is the only write on the critical path and it touches one table.
// ------------------------------------------------------------------
export function capture(db: Db, input: CaptureInput): number {
  const r = db.run(
    `INSERT INTO utterance (spoken_at, tz_offset_min, raw_text, stt_confidence, audio_path)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.spokenAt.toISOString(),
      input.tzOffsetMin,
      input.rawText,
      input.sttConfidence ?? null,
      input.audioPath ?? null,
    ],
  );
  return r.lastInsertRowid;
}

// ------------------------------------------------------------------
// Step 2 — FAST PATH. Match against YOUR index, not a global database.
// This is the whole differentiator: it knows what you meant by week two.
// ------------------------------------------------------------------
export function fastPath(db: Db, item: ParsedItem): Resolution | null {
  const threshold = getSetting(db, 'fuzzy_threshold');
  const minMargin = getSetting(db, 'min_match_margin');

  const exact = db.get<IndexRow>(
    `SELECT id, phrase, food_id, default_qty, default_unit_id
     FROM phrase_index WHERE phrase = ?`,
    [item.phrase],
  );

  let row: IndexRow | undefined = exact;
  let method: MatchMethod = 'exact_index';
  let score = 1.0;
  let runnerUp: string | null = null;
  let runnerUpScore: number | null = null;

  if (!row) {
    const m = fuzzyLookup(db, item.phrase);
    method = 'fuzzy_index';
    score = m.bestScore;
    runnerUp = m.runnerUp?.key ?? null;
    runnerUpScore = m.runnerUp ? m.runnerUpScore : null;

    const clearWinner =
      m.best !== null &&
      m.bestScore >= threshold &&
      (m.runnerUp === null || m.bestScore - m.runnerUpScore >= minMargin);

    if (!clearWinner) return null;
    row = m.best!.value;
  }

  const unitId = item.unitCode
    ? resolveUnitId(db, item.unitCode)
    : row.default_unit_id;
  const quantity = item.quantity;

  const base = {
    foodId: row.food_id,
    matchMethod: method,
    matchScore: score,
    chosenPhrase: row.phrase,
    runnerUp,
    runnerUpScore,
    threshold,
  };

  // Food is known. Quantity may not be. That is a pending field, NOT an
  // ambiguity — the entry still lands.
  if (quantity === null) {
    return { ...base, quantity: null, unitId, needsUser: true, reason: 'quantity_missing' };
  }
  if (unitId === null || unitId === undefined) {
    return { ...base, quantity, unitId: null, needsUser: true, reason: 'unit_missing' };
  }
  return { ...base, quantity, unitId, needsUser: false, reason: null };
}

export function fuzzyLookup(db: Db, phrase: string) {
  const rows = db.all<IndexRow>(
    'SELECT id, phrase, food_id, default_qty, default_unit_id FROM phrase_index',
  );
  const candidates: Array<Candidate<IndexRow>> = rows.map((r) => ({ key: r.phrase, value: r }));
  return bestMatch(phrase, candidates);
}

export function resolveUnitId(db: Db, unitCode: string | null): number | null {
  if (!unitCode) return null;
  const row = db.get<{ id: number }>('SELECT id FROM unit WHERE code = ?', [unitCode]);
  return row ? row.id : null;
}

// ------------------------------------------------------------------
// Step 3 — grams. Household measures resolve against YOUR calibration.
// Accuracy is not the goal here. STABILITY is. A personal constant that
// never moves is worth more than a population average that is closer to
// true, because the TDEE regression cancels stable bias and cannot cancel
// a wandering one.
// ------------------------------------------------------------------
export function toGrams(
  db: Db, foodId: number, quantity: number, unitId: number,
): number | null {
  const unit = db.get<{ is_absolute: number }>(
    'SELECT is_absolute FROM unit WHERE id = ?', [unitId],
  );
  if (!unit) return null;
  if (unit.is_absolute) return quantity;

  // Food-specific calibration wins over the general one for that unit.
  const measure = db.get<{ grams: number }>(
    `SELECT grams FROM user_measure
     WHERE unit_id = ? AND (food_id = ? OR food_id IS NULL)
     ORDER BY food_id IS NULL, calibrated_at DESC LIMIT 1`,
    [unitId, foodId],
  );
  // Uncalibrated household measure -> ask once, then never again.
  return measure ? quantity * measure.grams : null;
}

// ------------------------------------------------------------------
// Step 4 — write. Enforces the invariant: resolved rows are complete.
// ------------------------------------------------------------------
export function writeEntry(
  db: Db,
  utteranceId: number | null,
  eatenAt: Date,
  mealSlot: string | null,
  res: Resolution,
): { entryId: number; status: string; grams: number | null; reason: PendingReason | null } {
  let grams: number | null = null;
  let status = 'pending_quantity';
  let reason = res.reason;

  if (res.quantity !== null && res.unitId !== null) {
    grams = toGrams(db, res.foodId, res.quantity, res.unitId);
    if (grams !== null) {
      status = 'resolved';
      reason = null;
    } else {
      // We know the food and the amount. We do not know what that
      // household measure weighs for this user yet.
      reason = 'unit_uncalibrated';
    }
  }

  const r = db.run(
    `INSERT INTO log_entry
       (utterance_id, eaten_at, meal_slot, food_id, quantity, unit_id,
        grams_resolved, status, match_method, match_score, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      utteranceId, eatenAt.toISOString(), mealSlot, res.foodId,
      res.quantity, res.unitId, grams, status,
      res.matchMethod, res.matchScore, nowIso(),
    ],
  );
  return { entryId: r.lastInsertRowid, status, grams, reason };
}

// ------------------------------------------------------------------
// Step 5 — the write-back. Skip this and the app never gets faster.
//
// Gated on auto_learn_threshold, NOT on fuzzy_threshold. A marginal
// fuzzy hit is good enough to log once, where you can still see it in
// the day list. It is not good enough to become an EXACT match forever
// after, which is what writing it back to the index makes it. Below the
// gate the entry lands and the decision is recorded in match_audit for
// review; it just does not compound.
// ------------------------------------------------------------------
export function learn(
  db: Db,
  phrase: string,
  foodId: number,
  qty: number | null,
  unitId: number | null,
): void {
  db.run(
    `INSERT INTO phrase_index
       (phrase, food_id, default_qty, default_unit_id, hit_count, last_used_at)
     VALUES (?,?,?,?,1,?)
     ON CONFLICT(phrase) DO UPDATE SET
       hit_count       = hit_count + 1,
       last_used_at    = excluded.last_used_at,
       default_qty     = COALESCE(phrase_index.default_qty, excluded.default_qty),
       default_unit_id = COALESCE(phrase_index.default_unit_id, excluded.default_unit_id)`,
    [phrase, foodId, qty, unitId, nowIso()],
  );
}

export function shouldLearn(db: Db, res: Resolution): boolean {
  if (res.matchMethod === 'exact_index') return true;
  if (res.matchMethod === 'manual' || res.matchMethod === 'llm_resolved') return true;
  return res.matchScore >= getSetting(db, 'auto_learn_threshold');
}

function auditMatch(db: Db, args: {
  utteranceId: number | null;
  logEntryId: number | null;
  phrase: string;
  res: Resolution | null;
  fallback?: { score: number; chosen: string | null; runnerUp: string | null; runnerUpScore: number | null; threshold: number };
  accepted: boolean;
  learned: boolean;
}): void {
  const r = args.res;
  db.run(
    `INSERT INTO match_audit
       (utterance_id, log_entry_id, phrase, chosen_phrase, chosen_food_id,
        score, runner_up, runner_up_score, threshold, accepted, learned, decided_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      args.utteranceId, args.logEntryId, args.phrase,
      r ? r.chosenPhrase : (args.fallback?.chosen ?? null),
      r ? r.foodId : null,
      r ? r.matchScore : (args.fallback?.score ?? null),
      r ? r.runnerUp : (args.fallback?.runnerUp ?? null),
      r ? r.runnerUpScore : (args.fallback?.runnerUpScore ?? null),
      r ? r.threshold : (args.fallback?.threshold ?? 0),
      args.accepted ? 1 : 0,
      args.learned ? 1 : 0,
      nowIso(),
    ],
  );
}

// ------------------------------------------------------------------
// Step 6 — corrections are append-only. An in-place edit silently
// rewrites the model's training data with no record it happened.
// ------------------------------------------------------------------
const REVISABLE = new Set(['quantity', 'unit_id', 'food_id', 'eaten_at', 'meal_slot']);

export function revise(
  db: Db, logEntryId: number, field: string, newValue: string | number | null, reason: string,
): void {
  if (!REVISABLE.has(field)) throw new Error(`field not revisable: ${field}`);

  db.tx(() => {
    const before = db.get<Record<string, any>>(
      `SELECT ${field} AS v FROM log_entry WHERE id = ?`, [logEntryId],
    );
    if (!before) throw new Error(`no such log_entry: ${logEntryId}`);

    db.run(
      `INSERT INTO log_revision (log_entry_id, revised_at, field, old_value, new_value, reason)
       VALUES (?,?,?,?,?,?)`,
      [logEntryId, nowIso(), field, before.v === null ? null : String(before.v),
       newValue === null ? null : String(newValue), reason],
    );
    // Drop to pending BEFORE applying the change. The CHECK constraint is
    // evaluated per statement, so clearing a quantity on a row still marked
    // resolved trips it mid-edit even though the end state is legal.
    db.run(
      `UPDATE log_entry SET grams_resolved = NULL, status = 'pending_quantity'
       WHERE id = ?`, [logEntryId],
    );
    db.run(`UPDATE log_entry SET ${field} = ? WHERE id = ?`, [newValue as any, logEntryId]);

    // Re-derive status. A revision can complete a pending entry, and it can
    // also un-complete a resolved one (clearing a quantity, moving to an
    // uncalibrated unit). Both directions have to be honest.
    const row = db.get<{ food_id: number; quantity: number | null; unit_id: number | null }>(
      'SELECT food_id, quantity, unit_id FROM log_entry WHERE id = ?', [logEntryId],
    )!;
    let grams: number | null = null;
    if (row.quantity !== null && row.unit_id !== null) {
      grams = toGrams(db, row.food_id, row.quantity, row.unit_id);
    }
    db.run(
      `UPDATE log_entry SET grams_resolved = ?, status = ?, match_method = 'manual'
       WHERE id = ?`,
      [grams, grams !== null ? 'resolved' : 'pending_quantity', logEntryId],
    );
  });
}

/**
 * Recalibrating a household measure changes what every past entry in that
 * unit weighed. Rewriting them in place would move the model's training
 * data with no record; each one gets its own revision row instead.
 */
export function recalibrate(
  db: Db, unitId: number, foodId: number | null, grams: number,
  basis: 'weighed' | 'estimated',
): number {
  return db.tx(() => {
    // SQLite treats NULLs as distinct in a UNIQUE constraint, so
    // UNIQUE (food_id, unit_id) does NOT dedupe the general calibration
    // (food_id IS NULL). Without the partial-index conflict target below,
    // recalibrating "a katori" appends a second row and every lookup keeps
    // returning the stale one — a household measure that silently refuses
    // to move is precisely the bug this table exists to prevent.
    if (foodId === null) {
      db.run(
        `INSERT INTO user_measure (food_id, unit_id, grams, basis, calibrated_at)
         VALUES (NULL,?,?,?,?)
         ON CONFLICT(unit_id) WHERE food_id IS NULL DO UPDATE SET
           grams = excluded.grams, basis = excluded.basis,
           calibrated_at = excluded.calibrated_at`,
        [unitId, grams, basis, nowIso()],
      );
    } else {
      db.run(
        `INSERT INTO user_measure (food_id, unit_id, grams, basis, calibrated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(food_id, unit_id) DO UPDATE SET
           grams = excluded.grams, basis = excluded.basis,
           calibrated_at = excluded.calibrated_at`,
        [foodId, unitId, grams, basis, nowIso()],
      );
    }

    const affected = db.all<{ id: number; food_id: number; quantity: number; grams_resolved: number | null }>(
      `SELECT id, food_id, quantity, grams_resolved FROM log_entry
       WHERE unit_id = ? AND quantity IS NOT NULL
         AND (? IS NULL OR food_id = ?)`,
      [unitId, foodId, foodId],
    );

    let n = 0;
    for (const e of affected) {
      const next = toGrams(db, e.food_id, e.quantity, unitId);
      if (next === null || next === e.grams_resolved) continue;
      db.run(
        `INSERT INTO log_revision (log_entry_id, revised_at, field, old_value, new_value, reason)
         VALUES (?,?,?,?,?,'recalibration')`,
        [e.id, nowIso(), 'grams_resolved',
         e.grams_resolved === null ? null : String(e.grams_resolved), String(next)],
      );
      db.run(
        `UPDATE log_entry SET grams_resolved = ?, status = 'resolved' WHERE id = ?`,
        [next, e.id],
      );
      n++;
    }
    return n;
  });
}

// ------------------------------------------------------------------
// Undo. Replaces the confirmation step: capture commits immediately and
// stays committed unless actively revoked inside the window.
// The utterance is never deleted — only what was derived from it.
// ------------------------------------------------------------------
export function undoUtterance(db: Db, utteranceId: number): number {
  return db.tx(() => {
    const entries = db.all<{ id: number }>(
      'SELECT id FROM log_entry WHERE utterance_id = ?', [utteranceId],
    );
    const learned = db.all<{ phrase: string }>(
      'SELECT phrase FROM match_audit WHERE utterance_id = ? AND learned = 1', [utteranceId],
    );
    for (const l of learned) {
      db.run('UPDATE phrase_index SET hit_count = hit_count - 1 WHERE phrase = ?', [l.phrase]);
      db.run('DELETE FROM phrase_index WHERE phrase = ? AND hit_count <= 0', [l.phrase]);
    }
    db.run('DELETE FROM log_entry WHERE utterance_id = ?', [utteranceId]);
    db.run(
      `INSERT INTO undone_utterance (utterance_id, undone_at, entries_removed)
       VALUES (?,?,?)
       ON CONFLICT(utterance_id) DO UPDATE SET undone_at = excluded.undone_at`,
      [utteranceId, nowIso(), entries.length],
    );
    db.run('UPDATE utterance SET processed_at = ? WHERE id = ?', [nowIso(), utteranceId]);
    return entries.length;
  });
}

// ------------------------------------------------------------------
// Orchestration
// ------------------------------------------------------------------
export interface ItemOutcome {
  phrase: string;
  rawPhrase: string;
  action: 'logged' | 'slow_path';
  entryId?: number;
  status?: string;
  needsUser?: boolean;
  reason?: PendingReason | null;
  foodId?: number;
  matchMethod?: MatchMethod;
  matchScore?: number;
  learned?: boolean;
}

export interface UtteranceOutcome {
  utteranceId: number;
  items: ItemOutcome[];
  /** True when nothing about this utterance needs a human. */
  complete: boolean;
  fastPath: boolean;
}

export function handleUtterance(
  db: Db, input: CaptureInput, mealSlot: string | null = null,
): UtteranceOutcome {
  // Written first, outside the resolution transaction, so a failure below
  // cannot roll it back.
  const utteranceId = capture(db, input);

  const items = parse(input.rawText);
  const outcomes: ItemOutcome[] = [];

  db.tx(() => {
    for (const item of items) {
      const res = fastPath(db, item);

      if (res === null) {
        // SLOW PATH. Genuine ambiguity in food identity -> never written
        // to log_entry. Surface it, let the user resolve, then learn() so
        // it is fast forever after.
        const m = fuzzyLookup(db, item.phrase);
        auditMatch(db, {
          utteranceId, logEntryId: null, phrase: item.phrase, res: null,
          fallback: {
            score: m.bestScore,
            chosen: m.best?.key ?? null,
            runnerUp: m.runnerUp?.key ?? null,
            runnerUpScore: m.runnerUp ? m.runnerUpScore : null,
            threshold: getSetting(db, 'fuzzy_threshold'),
          },
          accepted: false, learned: false,
        });
        outcomes.push({ phrase: item.phrase, rawPhrase: item.rawPhrase, action: 'slow_path' });
        continue;
      }

      const w = writeEntry(db, utteranceId, input.spokenAt, mealSlot, res);
      const willLearn = shouldLearn(db, res);
      if (willLearn) learn(db, item.phrase, res.foodId, res.quantity, res.unitId);
      auditMatch(db, {
        utteranceId, logEntryId: w.entryId, phrase: item.phrase, res,
        accepted: true, learned: willLearn,
      });

      outcomes.push({
        phrase: item.phrase,
        rawPhrase: item.rawPhrase,
        action: 'logged',
        entryId: w.entryId,
        status: w.status,
        needsUser: w.status !== 'resolved',
        reason: w.reason,
        foodId: res.foodId,
        matchMethod: res.matchMethod,
        matchScore: res.matchScore,
        learned: willLearn,
      });
    }
  });

  // processed_at is set ONLY when every parsed item produced an entry and
  // at least one item parsed at all. Anything else — an unparseable
  // utterance, a slow-path item — leaves it NULL so the utterance stays
  // visible in v_orphan_utterance. This is the "zero logs lost" invariant:
  // nothing is ever quietly marked done with nothing to show for it.
  const allLanded = items.length > 0 && outcomes.every((o) => o.action === 'logged');
  if (allLanded) {
    db.run('UPDATE utterance SET processed_at = ? WHERE id = ?', [nowIso(), utteranceId]);
  }

  return {
    utteranceId,
    items: outcomes,
    complete: allLanded && outcomes.every((o) => !o.needsUser),
    fastPath: allLanded && outcomes.every((o) => o.matchMethod === 'exact_index'),
  };
}

/**
 * Slow-path completion. The user has said what the phrase meant; write the
 * entry, then teach the index so this phrase never comes back here.
 */
export function resolveSlowPath(
  db: Db, args: {
    utteranceId: number;
    phrase: string;
    foodId: number;
    quantity: number | null;
    unitId: number | null;
    eatenAt: Date;
    mealSlot?: string | null;
    method?: MatchMethod;
  },
): number {
  return db.tx(() => {
    const res: Resolution = {
      foodId: args.foodId,
      quantity: args.quantity,
      unitId: args.unitId,
      matchMethod: args.method ?? 'manual',
      matchScore: 1.0,
      needsUser: false,
      reason: null,
      chosenPhrase: args.phrase,
      runnerUp: null,
      runnerUpScore: null,
      threshold: getSetting(db, 'fuzzy_threshold'),
    };
    const w = writeEntry(db, args.utteranceId, args.eatenAt, args.mealSlot ?? null, res);
    learn(db, args.phrase, args.foodId, args.quantity, args.unitId);
    auditMatch(db, {
      utteranceId: args.utteranceId, logEntryId: w.entryId, phrase: args.phrase,
      res, accepted: true, learned: true,
    });

    const stillOpen = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM match_audit
       WHERE utterance_id = ? AND accepted = 0
         AND phrase NOT IN (SELECT phrase FROM phrase_index)`,
      [args.utteranceId],
    );
    if (!stillOpen || stillOpen.n === 0) {
      db.run('UPDATE utterance SET processed_at = ? WHERE id = ?', [nowIso(), args.utteranceId]);
    }
    return w.entryId;
  });
}
