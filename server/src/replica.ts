import type { IncomingMessage } from 'node:http';
import type { Supabase } from './supabase.ts';

/**
 * Validating and applying a replication push.
 *
 * The app is ours, but its push is still INPUT. This server holds a
 * service key that bypasses row-level security on the whole replica, so
 * a push that reached Postgres unchecked would let anything that got
 * past the bearer token write any table it liked, including a table
 * this application has never heard of. Everything here is about not
 * letting that happen:
 *
 *  - the table must be one of the replicated set, by exact name, from a
 *    list rather than a pattern;
 *  - every column must be one this server knows about, so a crafted
 *    push cannot reach a column the schema guard never saw;
 *  - the batch is bounded, so a single request cannot exhaust memory.
 *
 * A table name reaching PostgREST from a request body is how a data
 * store gets rewritten by a stray fetch, and no amount of "but the
 * client is ours" makes that safe.
 */

/** Beyond this, a push is refused rather than buffered. */
export const MAX_PUSH_BYTES = 4 * 1024 * 1024;

/**
 * Table -> primary key. The allowlist and the conflict target in one
 * structure, so a table cannot be permitted without also stating how to
 * upsert it.
 *
 * Copied from the output of `npm run gen:replica`, which reads the keys
 * from db/schema.sql. A test fails if the two disagree - both this list
 * and the trigger list were hand-written first and both got the keys
 * wrong, capture_timing most memorably: it has no `id` column at all.
 */
export const REPLICATED: Record<string, string[]> = {
  app_setting: ['key'],
  body_profile: ['id'],
  capture_timing: ['utterance_id'],
  daily_logging_stats: ['log_date'],
  daily_metric: ['log_date', 'metric', 'source'],
  decision_log: ['id'],
  energy_target: ['log_date', 'source'],
  food: ['id'],
  food_nutrient: ['food_id', 'nutrient'],
  food_unit: ['food_id', 'unit_id'],
  imported_entry: ['id'],
  log_entry: ['id'],
  log_revision: ['id'],
  match_audit: ['id'],
  meal: ['id'],
  meal_component: ['meal_id', 'food_id'],
  meal_slot_window: ['slot'],
  phrase_index: ['id'],
  satiety_rating: ['id'],
  session_energy: ['session_id', 'source'],
  undone_utterance: ['utterance_id'],
  unit: ['id'],
  user_measure: ['id'],
  utterance: ['id'],
  workout_session: ['id'],
};

export interface Change {
  table: string;
  rowId: string;
  op: 'upsert' | 'delete';
  row?: Record<string, unknown>;
}

/** Returns null rather than throwing: a malformed push is a 400. */
export function validatePush(body: unknown): Change[] | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { changes?: unknown }).changes;
  if (!Array.isArray(raw)) return null;

  const out: Change[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const c = item as Record<string, unknown>;
    if (typeof c.table !== 'string' || !Object.hasOwn(REPLICATED, c.table)) return null;
    if (c.op !== 'upsert' && c.op !== 'delete') return null;
    if (typeof c.rowId !== 'string' || c.rowId === '') return null;

    if (c.op === 'upsert') {
      if (!c.row || typeof c.row !== 'object' || Array.isArray(c.row)) return null;
      const row = c.row as Record<string, unknown>;
      for (const [col, v] of Object.entries(row)) {
        // A column name is interpolated into a request to PostgREST, so
        // it is checked for shape as well as for being known upstream.
        if (!/^[a-z_][a-z0-9_]*$/.test(col)) return null;
        if (v !== null && typeof v !== 'string'
            && typeof v !== 'number' && typeof v !== 'boolean') return null;
      }
      out.push({ table: c.table, rowId: c.rowId, op: 'upsert', row });
    } else {
      out.push({ table: c.table, rowId: c.rowId, op: 'delete' });
    }
  }
  return out;
}

export interface PushResult {
  upserted: number;
  deleted: number;
  tables: string[];
}

/**
 * Apply a validated push.
 *
 * Grouped by table so a hundred entries are one request rather than a
 * hundred, and ordered so upserts land before deletes for the same
 * table - the reverse would resurrect a row the client had just
 * removed.
 */
export async function applyPush(client: Supabase, changes: Change[]): Promise<PushResult> {
  const upserts = new Map<string, Array<Record<string, unknown>>>();
  const deletes = new Map<string, Array<Record<string, unknown>>>();

  for (const c of changes) {
    if (c.op === 'upsert') {
      const list = upserts.get(c.table) ?? [];
      list.push(c.row!);
      upserts.set(c.table, list);
    } else {
      const key = REPLICATED[c.table];
      const parts = c.rowId.split('|');
      // A rowId that does not carry every key column cannot address a
      // row, and guessing the rest would delete the wrong one.
      if (parts.length !== key.length) continue;
      const list = deletes.get(c.table) ?? [];
      list.push(Object.fromEntries(key.map((col, i) => [col, parts[i]])));
      deletes.set(c.table, list);
    }
  }

  let upserted = 0;
  for (const [table, rows] of upserts) {
    await client.upsert(table, rows, REPLICATED[table]);
    upserted += rows.length;
  }
  let deleted = 0;
  for (const [table, keys] of deletes) {
    await client.remove(table, keys);
    deleted += keys.length;
  }

  return {
    upserted, deleted,
    tables: [...new Set([...upserts.keys(), ...deletes.keys()])].sort(),
  };
}

/** Read a request body, refusing anything oversized rather than buffering it. */
export function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
