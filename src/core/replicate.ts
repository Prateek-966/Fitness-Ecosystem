import type { Db } from './db.ts';
import { localIso } from './clock.ts';

/**
 * Replication: the browser's database, copied into Postgres.
 *
 * WHAT THIS IS NOT. It is not the write path. Principle 2 says capture
 * never blocks, and a network round trip on the way to committing an
 * utterance is exactly the block it forbids. Nothing here is ever
 * awaited before an entry lands; replication reads changes that have
 * ALREADY been committed locally and carries them upstream afterwards.
 * Turn the network off and the app is unaffected.
 *
 * WHAT IT BUYS, and what it costs. Your history stops being one cleared
 * cache away from gone, and becomes queryable with SQL from anywhere.
 * The cost, stated plainly because the owner chose it with the trade in
 * front of them: months of health data sit in a hosted Postgres in
 * readable form.
 *
 * The credential never travels. app_secret has no replication trigger
 * and no table upstream, so there is no mechanism that could carry the
 * sync token even by mistake.
 *
 * Changes are captured by TRIGGER (see schema.sql section 20), not by
 * instrumenting each mutation, because every write path would otherwise
 * have to remember to record itself and the one that forgets loses data
 * silently.
 */

export interface PendingChange {
  seq: number;
  table: string;
  rowId: string;
  op: 'upsert' | 'delete';
  changedAt: string;
  /** The row's current state. Absent for a delete. */
  row?: Record<string, unknown>;
}

export interface PushBatch {
  changes: PendingChange[];
  /** Highest seq in this batch, for marking afterwards. */
  through: number;
}

/**
 * Primary key columns per table, read from the database itself rather
 * than listed here. A hand-maintained list is a list that goes stale
 * the first time someone adds a table.
 */
function primaryKey(db: Db, table: string): string[] {
  return db.all<{ name: string; pk: number }>(`PRAGMA table_info(${table})`)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

/** Tables that replicate, taken from the triggers so it cannot drift. */
export function replicatedTables(db: Db): string[] {
  return [...new Set(db.all<{ name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'trg_%_repl'`)
    .map((r) => /^trg_(.+)_(?:insert|update|delete)_repl$/.exec(r.name)?.[1] ?? '')
    .filter(Boolean))].sort();
}

/**
 * Everything not yet pushed, with each row's CURRENT state.
 *
 * Current state, not a recorded diff: the change log deliberately holds
 * no payload, so ten edits before a sync collapse to one row and the
 * push carries what the row looks like now. A log of intermediate
 * states would be bigger, slower and no more true.
 */
export function pendingChanges(db: Db, limit = 500): PushBatch {
  const rows = db.all<{ seq: number; table_name: string; row_id: string;
    op: 'upsert' | 'delete'; changed_at: string }>(
    `SELECT seq, table_name, row_id, op, changed_at FROM change_log
      WHERE pushed_at IS NULL ORDER BY seq LIMIT ?`, [limit]);

  const changes: PendingChange[] = [];
  for (const r of rows) {
    const change: PendingChange = {
      seq: r.seq, table: r.table_name, rowId: r.row_id,
      op: r.op, changedAt: r.changed_at,
    };
    if (r.op === 'upsert') {
      const key = primaryKey(db, r.table_name);
      const parts = r.row_id.split('|');
      const where = key.map((c) => `${c} = ?`).join(' AND ');
      const row = db.get<Record<string, unknown>>(
        `SELECT * FROM ${r.table_name} WHERE ${where}`, parts);
      // Deleted between the trigger firing and this read. The delete
      // has its own change row, so dropping this one loses nothing.
      if (!row) continue;
      change.row = row;
    }
    changes.push(change);
  }
  return { changes, through: rows.length ? rows[rows.length - 1].seq : 0 };
}

/**
 * Mark a batch as pushed.
 *
 * By SEQ, and only up to what was actually sent. A row edited during
 * the round trip gets a new change row with a higher seq, so marking a
 * range can never swallow a change that happened after the read - the
 * failure mode where an edit made mid-sync is silently never replicated.
 */
export function markPushed(db: Db, seqs: number[], now = localIso()): number {
  if (seqs.length === 0) return 0;
  const holes = seqs.map(() => '?').join(',');
  return db.run(
    `UPDATE change_log SET pushed_at = ? WHERE seq IN (${holes}) AND pushed_at IS NULL`,
    [now, ...seqs]).changes;
}

/** How far behind the replica is. Shown rather than hidden. */
export function replicaLag(db: Db): { pending: number; oldest: string | null } {
  const row = db.get<{ n: number; oldest: string | null }>(
    `SELECT COUNT(*) AS n, MIN(changed_at) AS oldest
       FROM change_log WHERE pushed_at IS NULL`);
  return { pending: row?.n ?? 0, oldest: row?.oldest ?? null };
}

/**
 * Forget the history of what has already been carried upstream.
 *
 * The change log is a queue, not a second copy of the database. Rows
 * that have been pushed have done their job, and keeping them forever
 * would grow a table that nothing ever reads.
 */
export function pruneChangeLog(db: Db, keep = 2000): number {
  return db.run(
    `DELETE FROM change_log
      WHERE pushed_at IS NOT NULL
        AND seq <= COALESCE(
          (SELECT seq FROM change_log WHERE pushed_at IS NOT NULL
            ORDER BY seq DESC LIMIT 1 OFFSET ?), -1)`, [keep]).changes;
}

/**
 * A full re-push, for a replica that has been emptied or a device that
 * has never synced. Marks every row of every replicated table pending.
 */
export function markEverythingPending(db: Db, now = localIso()): number {
  let n = 0;
  db.tx(() => {
    for (const table of replicatedTables(db)) {
      const key = primaryKey(db, table);
      if (key.length === 0) continue;
      const rowId = key.map((c) => `CAST(${c} AS TEXT)`).join(" || '|' || ");
      n += db.run(
        `INSERT INTO change_log (table_name, row_id, op, changed_at)
         SELECT '${table}', ${rowId}, 'upsert', ?
           FROM ${table}
         WHERE true
         ON CONFLICT(table_name, row_id) WHERE pushed_at IS NULL DO NOTHING`,
        [now]).changes;
    }
  });
  return n;
}
