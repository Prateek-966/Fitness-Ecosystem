/**
 * The only database surface the core logic is allowed to see.
 *
 * Both implementations are synchronous by design. The capture path
 * must commit an utterance without ever yielding to an event loop,
 * a promise chain, or anything that can be interrupted by the app
 * being backgrounded mid-write.
 */

export type Row = Record<string, any>;
export type Param = string | number | null;

export interface Db {
  exec(sql: string): void;
  all<T = Row>(sql: string, params?: Param[]): T[];
  get<T = Row>(sql: string, params?: Param[]): T | undefined;
  run(sql: string, params?: Param[]): { lastInsertRowid: number; changes: number };
  /** Wraps fn in a transaction. Rolls back and rethrows on any throw. */
  tx<T>(fn: () => T): T;
  close(): void;
}

/**
 * Brings any database up to the shape schema.sql describes.
 *
 * This used to run schema.sql only when a sentinel table was absent,
 * which meant a database created before a table was added NEVER got it -
 * the app opened, then died on the first query against the missing
 * relation. That is exactly what happened with `body_profile` when goal
 * setting landed, in a browser whose OPFS database predated it.
 *
 * So schema.sql is now idempotent and always runs: tables and indexes
 * are IF NOT EXISTS, and views are dropped and recreated - they hold no
 * data, so replacing them is free and guarantees the definition running
 * is the one in the file rather than a stale copy from an older release.
 *
 * The consequence worth stating: adding a table to schema.sql is now
 * enough. Adding a COLUMN to an existing table is not, because
 * IF NOT EXISTS skips the whole statement - those go in LATE_COLUMNS.
 */
export function initSchema(db: Db, schemaSql: string, seedSql: string): void {
  // Before, not only after: schema.sql recreates the views, and a view
  // that selects a late column cannot be built until the column exists.
  // Getting this order wrong fails the open outright - the same crash
  // this function is here to prevent, arriving by a different route.
  addLateColumns(db);
  db.exec(schemaSql);
  db.exec(seedSql);
  addLateColumns(db);
}

/**
 * Columns added after a database may already exist in the wild.
 *
 * These cannot live in seed.sql the way the late indexes do: seed.sql
 * runs on every open, and SQLite has no
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so the second open would
 * throw. Checked against the live table instead.
 *
 * schema.sql already declares them, so this is a no-op for a database
 * created fresh - schema.sql stays the single source of truth for what
 * the shape should be, and this only catches up databases that predate
 * it.
 */
const LATE_COLUMNS: Record<string, Record<string, string>> = {
  workout_session: {
    distance_m: 'REAL',
    avg_hr: 'REAL',
    training_load: 'REAL',
    aerobic_effect: 'REAL',
    anaerobic_effect: 'REAL',
  },
};

function addLateColumns(db: Db): void {
  for (const [table, columns] of Object.entries(LATE_COLUMNS)) {
    const present = new Set(
      db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name));
    // No rows means no such table, and ALTER would throw a confusing
    // error about the column instead.
    if (present.size === 0) continue;
    for (const [name, type] of Object.entries(columns)) {
      if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}
