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

/** Applies schema + seed to an empty database. Idempotent on seed, not on schema. */
export function initSchema(db: Db, schemaSql: string, seedSql: string): void {
  const already = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='utterance'",
  );
  if (!already || already.n === 0) db.exec(schemaSql);
  db.exec(seedSql);
}
