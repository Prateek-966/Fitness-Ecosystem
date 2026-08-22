/// <reference lib="webworker" />
import schemaSql from '../../db/schema.sql?raw';
import seedSql from '../../db/seed.sql?raw';
import { initSchema, type Db } from '../core/db';
import { openDatabase, type BrowserDb } from '../platform/browser-db';
import {
  handleUtterance, recalibrate, resolveSlowPath, revise, undoUtterance,
} from '../core/resolve';
import { recordTiming } from '../core/timing';
import { diagnostics, refreshAllStats } from '../core/stats';
import { dayEntries, dayTotals, orphanItems, pendingQueue } from '../core/totals';
import { refreshWindows, slotFor } from '../core/mealslot';
import { allSettings, setSetting } from '../core/settings';
import { importHealthify, parseHealthifyCsv } from '../core/healthify';
import { loadFoods, parseFoodCsv } from '../core/foodimport';
import { importGarminCsv, sourceCoverage } from '../core/garmin';
import { absNow, localDate } from '../core/clock';
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
    persistent,
  };
}

function refresh(): void {
  refreshAllStats(db);
  if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM imported_entry')!.n > 0) {
    refreshWindows(db, 'imported_entry');
  }
}

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'boot': {
      const opened = await openDatabase();
      db = opened.db;
      persistent = opened.persistent;
      initSchema(db, schemaSql, seedSql);
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
        slotFor(db, spokenAt),
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
      return db.all(
        `SELECT id, name, brand, source FROM food
         WHERE name LIKE ? ESCAPE '\\' ORDER BY LENGTH(name) LIMIT 12`,
        [`%${q}%`],
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
