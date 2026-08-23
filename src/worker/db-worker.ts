/// <reference lib="webworker" />
import schemaSql from '../../db/schema.sql?raw';
import seedSql from '../../db/seed.sql?raw';
import starterFoodsCsv from '../../db/foods.starter.csv?raw';
import { initSchema, type Db } from '../core/db';
import { openDatabase, type BrowserDb } from '../platform/browser-db';
import {
  handleUtterance, recalibrate, resolveSlowPath, revise, undoUtterance,
} from '../core/resolve';
import { recordTiming } from '../core/timing';
import { diagnostics, refreshAllStats } from '../core/stats';
import { dayEntries, dayTotals, orphanItems, pendingQueue } from '../core/totals';
import { autoRefreshWindows, listWindows, refreshWindows, slotFor } from '../core/mealslot';
import { allSettings, setSetting } from '../core/settings';
import { importHealthify, parseHealthifyCsv } from '../core/healthify';
import { loadFoods, parseFoodCsv } from '../core/foodimport';
import { importGarminCsv, sourceCoverage } from '../core/garmin';
import {
  activeTarget, allTargets, clearManualTarget, currentProfile, macroBudget,
  mealTargets, saveProfile, setManualTarget, weightProgress, writeTargets,
} from '../core/energy';
import { clearPlan, planWeek, writePlan } from '../core/cycling';
import {
  hasSyncToken, lastPulledAt, pullFromSync, setSyncToken, syncStatus, triggerSync,
} from '../core/sync';
import { absNow, localDate, localIso } from '../core/clock';
import type { Envelope, Reply, Request, Snapshot } from '../app/protocol';

/**
 * The database lives here, not on the main thread.
 *
 * This is not an optimisation. OPFS synchronous access handles — the only
 * way to give SQLite durable local storage without asking the host to send
 * COOP/COEP headers — exist only inside a worker. Putting the database
 * here is what lets the app be a plain static site and still keep your
 * data across a reload.
 *
 * Everything below runs synchronously against a real SQLite connection.
 * The capture write in particular never yields between "speech-to-text
 * returned" and "row committed".
 */

let db: Db;
let persistent = false;

function snapshot(): Snapshot {
  const date = localDate();
  return {
    date,
    totals: dayTotals(db, date),
    entries: dayEntries(db, date),
    pending: pendingQueue(db),
    orphanItems: orphanItems(db),
    units: db.all(
      `SELECT u.id, u.code, u.is_absolute,
              (SELECT grams FROM user_measure m
               WHERE m.unit_id = u.id AND m.food_id IS NULL) AS grams
       FROM unit u ORDER BY u.is_absolute DESC, u.code`,
    ),
    diagnostics: diagnostics(db),
    settings: allSettings(db),
    indexSize: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM phrase_index')!.n,
    foodCount: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM food')!.n,
    sourceCoverage: sourceCoverage(db),
    mealWindows: listWindows(db),
    ...goalSnapshot(date),
    persistent,
  };
}

/** Everything goal-related, assembled once so the UI gets it in one hop. */
/**
 * Sync state is refreshed by the sync actions rather than fetched on
 * every snapshot: a snapshot is built on the capture path, and that path
 * does not make network calls.
 */
let lastSyncStatus: import('../core/sync').SyncStatus | null = null;
let lastSyncError: string | null = null;

function goalSnapshot(date: string) {
  // One read of the active target, reused throughout - this runs inside
  // every snapshot, including the one on the capture path.
  const target = activeTarget(db, date);
  const s = allSettings(db);
  return {
    profile: currentProfile(db),
    target,
    targetSpread: allTargets(db, date),
    mealTargets: target ? mealTargets(db, target.kcal) : [],
    macros: target
      ? macroBudget(
          target.kcal,
          { proteinPct: s.macro_protein_pct, carbPct: s.macro_carb_pct, fatPct: s.macro_fat_pct },
          s.fibre_g_per_1000kcal)
      : null,
    weight: weightProgress(db),
    weekPlan: db.all<any>(
      `SELECT log_date AS logDate, kcal, basis FROM energy_target
       WHERE source = 'cycled' AND log_date >= ? ORDER BY log_date LIMIT 7`, [date])
      .map((r) => ({ ...r, weight: 1, reasons: [] })),
    stepsToday: db.get<{ value: number }>(
      "SELECT value FROM v_daily_metric WHERE log_date = ? AND metric = 'steps'", [date])?.value
      ?? null,
    waterToday: db.get<{ value: number }>(
      "SELECT value FROM v_daily_metric WHERE log_date = ? AND metric = 'water_glasses'", [date])
      ?.value ?? 0,
    syncConfigured: hasSyncToken(db),
    syncStatus: lastSyncStatus,
    syncLastPulled: lastPulledAt(db),
    syncError: lastSyncError,
  };
}

function refresh(): void {
  refreshAllStats(db);
  autoRefreshWindows(db);
  // Today's target is recomputed from the current profile, so a new
  // weight moves tomorrow's line without rewriting yesterday's.
  const p = currentProfile(db);
  if (p) writeTargets(db, p);
}

/**
 * Put something in the food table on a database that has never had any.
 *
 * The app shipped with nothing, on the reasoning that no food database
 * is ours to redistribute - which is true of IFCT 2017 and was the
 * right call for it. The cost was a first open that looks identical to
 * a broken app: no foods means nothing resolves, so nothing can be
 * logged, and the screen says "nothing logged yet" as though that were
 * a choice the user made.
 *
 * So a small starter bank ships as DATA, in db/foods.starter.csv, and
 * goes in through the same loadFoods() path as any other import - with
 * a source and a relative error, never as values written into code,
 * which principle 5 forbids outright.
 *
 * Only on an EMPTY table. Someone who has loaded a real food table, or
 * deleted rows deliberately, does not want 125 rows appearing again on
 * next launch.
 */
function seedStarterFoods(db: Db): void {
  const existing = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM food')!.n;
  if (existing > 0) return;
  const { records } = parseFoodCsv(starterFoodsCsv);
  loadFoods(db, records, 'starter');
}

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'boot': {
      const opened = await openDatabase();
      db = opened.db;
      persistent = opened.persistent;
      initSchema(db, schemaSql, seedSql);
      seedStarterFoods(db);
      refresh();
      return snapshot();
    }

    case 'snapshot':
      refresh();
      return snapshot();

    case 'log': {
      // The capture path. One message in, one message out; everything
      // between these two lines is synchronous.
      const spokenAt = new Date();
      const utteranceCommitted = absNow();
      const outcome = handleUtterance(
        db,
        {
          rawText: req.transcript,
          sttConfidence: req.confidence,
          spokenAt,
          tzOffsetMin: -spokenAt.getTimezoneOffset(),
        },
        // An explicit choice wins: logging breakfast at 3pm because you
        // forgot is a normal thing to do, and the clock should not
        // overrule you about it.
        req.mealSlot ?? slotFor(db, spokenAt),
      );
      const totalMs = recordTiming(
        db, outcome.utteranceId,
        {
          micTap: req.micTap,
          sttReturned: req.sttReturned,
          utteranceCommitted,
          entriesCommitted: absNow(),
        },
        outcome.fastPath,
        outcome.items.filter((i) => i.action === 'logged').length,
      );
      return { outcome: { ...outcome, totalMs }, snapshot: snapshot() };
    }

    case 'undo':
      undoUtterance(db, req.utteranceId);
      return snapshot();

    case 'revise':
      revise(db, req.entryId, req.field, req.value, req.reason);
      return snapshot();

    case 'resolveSlowPath':
      resolveSlowPath(db, {
        utteranceId: req.utteranceId,
        phrase: req.phrase,
        foodId: req.foodId,
        quantity: req.quantity,
        unitId: req.unitId,
        eatenAt: new Date(req.eatenAt),
      });
      return snapshot();

    case 'recalibrate': {
      const n = recalibrate(db, req.unitId, req.foodId, req.grams, req.basis);
      return { revised: n, snapshot: snapshot() };
    }

    case 'setSetting':
      setSetting(db, req.key, req.value);
      return snapshot();

    case 'searchFoods': {
      // % and _ are LIKE wildcards; a search for "100_ juice" should match
      // literally, not as a pattern.
      const q = req.q.replace(/[\\%_]/g, (c) => `\\${c}`);
      const like = q.toLowerCase();
      // kcal comes along because a picker showing only names makes the
      // user choose blind between "Rice white cooked" and "Pulao".
      //
      // Matches must begin a WORD. A bare substring match means "rot"
      // offers carrot and whey protein isolate, which is not a search
      // result, it is a coincidence. Nothing is lost that a person
      // would have wanted: no one types the middle of a word.
      return db.all(
        `SELECT f.id, f.name, f.brand, f.source,
                (SELECT per_100g FROM food_nutrient
                  WHERE food_id = f.id AND nutrient = 'kcal') AS kcal
           FROM food f
          WHERE LOWER(f.name) LIKE ? ESCAPE '\\'
             OR LOWER(f.name) LIKE ? ESCAPE '\\'
          ORDER BY
            -- Starting the name beats starting a later word: "rice"
            -- offers Rice before Curd rice.
            CASE WHEN LOWER(f.name) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
            LENGTH(f.name)
          LIMIT 12`,
        [`${like}%`, `% ${like}%`, `${like}%`],
      );
    }

    case 'importFood': {
      const { records, unmapped } = parseFoodCsv(req.csv);
      const report = loadFoods(db, records, req.source);
      return { report: { ...report, unmapped }, snapshot: snapshot() };
    }

    case 'importHealthify': {
      const { rows, dropped } = parseHealthifyCsv(req.csv);
      const report = importHealthify(db, rows, dropped);
      refreshWindows(db, 'imported_entry');
      return { report, snapshot: snapshot() };
    }

    case 'importGarmin': {
      const report = importGarminCsv(db, req.csv);
      return { report, snapshot: snapshot() };
    }

    case 'saveProfile': {
      saveProfile(db, req.profile);
      writeTargets(db, req.profile);
      return snapshot();
    }

    case 'setManualTarget': {
      if (req.kcal === null) clearManualTarget(db);
      else setManualTarget(db, req.kcal);
      return snapshot();
    }

    case 'planWeek': {
      const t = activeTarget(db, localDate());
      if (!t) return snapshot();
      // Plan from the FLAT target, not from whatever is in force - otherwise
      // each replan would cycle an already-cycled number and drift.
      const flatRow = db.get<{ kcal: number }>(
        `SELECT kcal FROM energy_target WHERE log_date = ?
           AND source IN ('mifflin','harris','katch','manual')
         ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'mifflin' THEN 1
                              WHEN 'harris' THEN 2 ELSE 3 END LIMIT 1`,
        [localDate()]);
      const p = currentProfile(db);
      const { plan } = planWeek(db, flatRow?.kcal ?? t.kcal, localDate(), 7, {
        maxSwing: allSettings(db).max_cycle_swing,
        sex: p?.sex,
      });
      writePlan(db, plan);
      return snapshot();
    }

    case 'clearPlan':
      // Today forward only. What the target WAS on a logged day is part
      // of that day's record.
      clearPlan(db, localDate());
      return snapshot();

    case 'logWater': {
      if (!Number.isFinite(req.glasses)) return snapshot();
      db.run(
        `INSERT INTO daily_metric (log_date, metric, source, value, recorded_at)
         VALUES (?, 'water_glasses', 'manual', ?, ?)
         ON CONFLICT(log_date, metric, source) DO UPDATE SET
           value = excluded.value, recorded_at = excluded.recorded_at`,
        [localDate(), Math.max(0, req.glasses), localIso()]);
      return snapshot();
    }

    case 'setSyncToken': {
      setSyncToken(db, req.token);
      lastSyncStatus = null;
      lastSyncError = null;
      if (req.token) {
        // Verify immediately: a token that does not work should say so
        // now, not the first time a sync silently returns nothing.
        try { lastSyncStatus = await syncStatus(db); }
        catch (e) { lastSyncError = e instanceof Error ? e.message : String(e); }
      }
      return snapshot();
    }

    case 'syncNow': {
      lastSyncError = null;
      try {
        // Ask the server to refresh from Garmin, then collect what it has.
        // A failure to reach Garmin still lets us import the last good
        // window: stale data clearly labelled beats no data silently.
        try { await triggerSync(db); }
        catch (e) { lastSyncError = e instanceof Error ? e.message : String(e); }
        const out = await pullFromSync(db);
        lastSyncStatus = await syncStatus(db).catch(() => lastSyncStatus);
        return { outcome: out, snapshot: snapshot() };
      } catch (e) {
        lastSyncError = e instanceof Error ? e.message : String(e);
        return { outcome: null, snapshot: snapshot() };
      }
    }

    case 'exportDb': {
      const d = db as BrowserDb;
      return typeof d.export === 'function' ? d.export() : null;
    }
  }
}

self.onmessage = async (ev: MessageEvent<Envelope>) => {
  const { id, req } = ev.data;
  try {
    const result = await handle(req);
    (self as unknown as Worker).postMessage({ id, ok: true, result } satisfies Reply);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      id, ok: false, error: e instanceof Error ? `${e.message}` : String(e),
    } satisfies Reply);
  }
};
