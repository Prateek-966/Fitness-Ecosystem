import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { GarminPull } from './garmin/client.ts';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:' + 'sqlite') as {
  DatabaseSync: new (path: string) => any;
};

/**
 * What the server keeps, and what it deliberately does not.
 *
 * It holds session tokens and a ROLLING WINDOW of what Garmin last
 * returned - enough for the app to come along and collect it. It is not
 * the store of record: your history lives in your browser. Delete this
 * database and you lose the automation, not the data.
 */
export class SyncStore {
  private db: any;

  constructor(path: string) {
    const abs = resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new DatabaseSync(abs);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS window_activity (
        started_at   TEXT NOT NULL,
        kind         TEXT,
        duration_min REAL,
        kcal         REAL,
        title        TEXT,
        PRIMARY KEY (started_at, kind)
      );
      CREATE TABLE IF NOT EXISTS window_day (
        log_date TEXT NOT NULL,
        metric   TEXT NOT NULL,
        value    REAL NOT NULL,
        PRIMARY KEY (log_date, metric)
      );
    `);

    // Additive, so an existing deployment gains the columns without a
    // migration step. ALTER TABLE ADD COLUMN throws if it is already
    // there, and there is no IF NOT EXISTS for it in SQLite.
    for (const col of ['distance_m REAL', 'avg_hr REAL',
      'training_load REAL', 'aerobic_effect REAL', 'anaerobic_effect REAL']) {
      try {
        this.db.exec(`ALTER TABLE window_activity ADD COLUMN ${col}`);
      } catch {
        // Already present.
      }
    }
  }

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  set(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  /** Upserts, so an overlapping pull corrects rather than duplicates. */
  save(pull: GarminPull): { activities: number; metrics: number } {
    let metrics = 0;
    const insA = this.db.prepare(
      `INSERT INTO window_activity (started_at, kind, duration_min, kcal, title,
                                    distance_m, avg_hr, training_load,
                                    aerobic_effect, anaerobic_effect)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(started_at, kind) DO UPDATE SET
         duration_min = excluded.duration_min, kcal = excluded.kcal,
         title = excluded.title, distance_m = excluded.distance_m,
         avg_hr = excluded.avg_hr, training_load = excluded.training_load,
         aerobic_effect = excluded.aerobic_effect,
         anaerobic_effect = excluded.anaerobic_effect`);
    const insD = this.db.prepare(
      `INSERT INTO window_day (log_date, metric, value) VALUES (?,?,?)
       ON CONFLICT(log_date, metric) DO UPDATE SET value = excluded.value`);

    this.db.exec('BEGIN');
    try {
      for (const a of pull.activities) {
        insA.run(a.startedAt, a.kind ?? '', a.durationMin, a.kcal, a.title,
          a.distanceM ?? null, a.avgHr ?? null, a.trainingLoad ?? null,
          a.aerobicEffect ?? null, a.anaerobicEffect ?? null);
      }
      for (const d of pull.days) {
        for (const [metric, value] of Object.entries(d.metrics)) {
          if (value === undefined) continue;
          insD.run(d.logDate, metric, value);
          metrics++;
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { activities: pull.activities.length, metrics };
  }

  read(since: string): GarminPull {
    const activities = this.db.prepare(
      `SELECT started_at, kind, duration_min, kcal, title, distance_m, avg_hr,
              training_load, aerobic_effect, anaerobic_effect
         FROM window_activity
        WHERE started_at >= ? ORDER BY started_at`).all(since).map((r: any) => ({
        startedAt: r.started_at,
        kind: r.kind === '' ? null : r.kind,
        durationMin: r.duration_min,
        kcal: r.kcal,
        title: r.title,
        distanceM: r.distance_m,
        avgHr: r.avg_hr,
        trainingLoad: r.training_load,
        aerobicEffect: r.aerobic_effect,
        anaerobicEffect: r.anaerobic_effect,
      }));

    const byDate = new Map<string, Record<string, number>>();
    for (const r of this.db.prepare(
      'SELECT log_date, metric, value FROM window_day WHERE log_date >= ? ORDER BY log_date')
      .all(since) as any[]) {
      const m = byDate.get(r.log_date) ?? {};
      m[r.metric] = r.value;
      byDate.set(r.log_date, m);
    }

    return {
      activities,
      days: [...byDate.entries()].map(([logDate, metrics]) => ({ logDate, metrics })),
    };
  }

  /** Keeps the window bounded. The app has the history; this is a buffer. */
  prune(before: string): number {
    const a = this.db.prepare('DELETE FROM window_activity WHERE started_at < ?').run(before);
    const d = this.db.prepare('DELETE FROM window_day WHERE log_date < ?').run(before);
    return Number(a.changes) + Number(d.changes);
  }

  close(): void { this.db.close(); }
}
