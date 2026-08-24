import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freshDb } from './helpers';
import {
  markEverythingPending, markPushed, pendingChanges, pruneChangeLog, replicaLag,
} from '../src/core/replicate';

/**
 * The replica has to agree with the original.
 *
 * A Postgres copy that quietly lacks a table, or a table that quietly
 * lacks a column, does not fail loudly - it just stops carrying part of
 * the history, and you find out when you go looking for something that
 * is not there. So the agreement is asserted rather than maintained by
 * hand.
 */

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const REPLICA = readFileSync(new URL('../db/supabase/0001_replica.sql', import.meta.url), 'utf8');

/** Tables the local schema replicates, taken from the triggers themselves. */
const replicatedTables = (): string[] => [...new Set(
  [...SCHEMA.matchAll(/CREATE TRIGGER IF NOT EXISTS trg_(\w+?)_(?:insert|update|delete)_repl/g)]
    .map((m) => m[1]))].sort();

const pgTables = (): string[] =>
  [...REPLICA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();

describe('the Postgres replica matches the local schema', () => {
  it('has a table for everything that is replicated', () => {
    const missing = replicatedTables().filter((t) => !pgTables().includes(t));
    expect(missing, 'replicated locally but absent upstream').toEqual([]);
  });

  it('replicates nothing that does not exist locally', () => {
    const localTables = new Set(
      [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]));
    const extra = pgTables().filter((t) => !localTables.has(t));
    expect(extra, 'upstream table with no local original').toEqual([]);
  });

  it('carries every column of every replicated table', () => {
    // The one that actually bites: adding a column locally and
    // forgetting the replica means that field silently stops being
    // backed up, and nothing complains until you need it.
    const db = freshDb();
    const gaps: string[] = [];
    for (const table of replicatedTables()) {
      const local = db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => r.name);
      const block = new RegExp(
        `CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`).exec(REPLICA);
      if (!block) { gaps.push(`${table}: no upstream table`); continue; }
      for (const col of local) {
        if (!new RegExp(`\\b${col}\\b`).test(block[1])) gaps.push(`${table}.${col}`);
      }
    }
    expect(gaps, 'columns missing from the replica').toEqual([]);
  });

  it('never replicates the sync credential', () => {
    // app_secret holds the bearer token. The guarantee that it cannot
    // leave this device is that no mechanism exists to carry it - no
    // trigger, and no table upstream to carry it into.
    expect(replicatedTables()).not.toContain('app_secret');
    expect(pgTables()).not.toContain('app_secret');
    expect(SCHEMA).not.toMatch(/TRIGGER[^;]*ON app_secret/);
  });

  it('denies everything by default upstream', () => {
    // RLS enabled with no policy: anon and authenticated read nothing,
    // service_role bypasses. A policy appearing here without a very
    // good reason is someone opening the database to the internet.
    expect(REPLICA).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(REPLICA).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(REPLICA).not.toMatch(/CREATE POLICY/);
  });

  it('stores timestamps as text, not as a zoned type', () => {
    // The app writes LOCAL wall time with no zone suffix. Letting
    // Postgres parse those as timestamptz would apply the server's zone
    // and file an IST 00:30 dinner on the previous day - a bug this
    // project has already paid for once.
    const eaten = /eaten_at (\w+)/.exec(REPLICA);
    expect(eaten?.[1]).toBe('text');
    expect(REPLICA).not.toMatch(/eaten_at timestamptz/);
  });
});

describe('the generated file is actually current', () => {
  it('matches what the generator produces from the local schema', () => {
    // Otherwise the generator is a thing someone ran once. Changing
    // db/schema.sql without regenerating would leave the replica behind
    // and this suite green, which is the worst of both.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const before = readFileSync(new URL('../db/supabase/0001_replica.sql', import.meta.url), 'utf8');
    execFileSync('node', ['--experimental-strip-types', 'scripts/gen-replica-sql.ts'],
      { cwd: new URL('../', import.meta.url).pathname, stdio: 'pipe' });
    const after = readFileSync(new URL('../db/supabase/0001_replica.sql', import.meta.url), 'utf8');
    expect(after, 'run: npm run gen:replica').toBe(before);
  });
});

describe('the change log', () => {
  it('records a row for every write, without anyone remembering to', () => {
    // Captured by trigger precisely so a future write path that does
    // not know replication exists still gets replicated.
    const db = freshDb();
    db.run('DELETE FROM change_log');
    db.run(`INSERT INTO food (name, is_composite, source, created_at)
            VALUES ('Test food', 0, 'starter', '2026-08-24T10:00:00')`);
    const rows = db.all<{ table_name: string; op: string }>('SELECT * FROM change_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ table_name: 'food', op: 'upsert' });
  });

  it('collapses repeated edits of one row into one pending change', () => {
    // Editing an entry ten times before a sync should push it once:
    // the push reads the row's CURRENT state, so the nine earlier
    // entries carry no information at all.
    const db = freshDb();
    const id = db.run(`INSERT INTO food (name, is_composite, source, created_at)
                       VALUES ('Edited', 0, 'starter', 't')`).lastInsertRowid;
    db.run('DELETE FROM change_log');
    for (let i = 0; i < 10; i++) {
      db.run('UPDATE food SET name = ? WHERE id = ?', [`Edited ${i}`, id]);
    }
    expect(db.all('SELECT * FROM change_log')).toHaveLength(1);
  });

  it('keeps changes to different rows apart', () => {
    const db = freshDb();
    db.run('DELETE FROM change_log');
    for (const n of ['A', 'B', 'C']) {
      db.run(`INSERT INTO food (name, is_composite, source, created_at)
              VALUES (?, 0, 'starter', 't')`, [n]);
    }
    expect(db.all('SELECT * FROM change_log')).toHaveLength(3);
  });

  it('distinguishes rows of a table with a composite key', () => {
    // Keying the change log on the first column alone made two
    // genuinely different rows collide, and the unique index then
    // dropped one of them silently.
    const db = freshDb();
    const food = db.run(`INSERT INTO food (name, is_composite, source, created_at)
                         VALUES ('Multi', 0, 'starter', 't')`).lastInsertRowid;
    db.run('DELETE FROM change_log');
    for (const n of ['kcal', 'protein_g', 'fat_g']) {
      db.run(`INSERT INTO food_nutrient (food_id, nutrient, per_100g, rel_error)
              VALUES (?,?,?,0.2)`, [food, n, 10]);
    }
    const rows = db.all<{ row_id: string }>(
      "SELECT row_id FROM change_log WHERE table_name = 'food_nutrient'");
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.row_id)).size).toBe(3);
  });

  it('records a deletion, so the replica does not keep a deleted row', () => {
    const db = freshDb();
    const id = db.run(`INSERT INTO food (name, is_composite, source, created_at)
                       VALUES ('Doomed', 0, 'starter', 't')`).lastInsertRowid;
    db.run('DELETE FROM change_log');
    db.run('DELETE FROM food WHERE id = ?', [id]);
    expect(db.get<{ op: string }>('SELECT op FROM change_log')?.op).toBe('delete');
  });

  it('does not record the sync credential', () => {
    const db = freshDb();
    db.run('DELETE FROM change_log');
    db.run(`INSERT INTO app_secret (key, value) VALUES ('sync_token', 'super-secret')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    expect(db.all('SELECT * FROM change_log')).toEqual([]);
  });
});

// -----------------------------------------------------------------
describe('building a push', () => {
  it('carries the row as it is NOW, not as it was when edited', () => {
    // The change log holds no payload on purpose: ten edits collapse to
    // one row and the push sends the current state. A log of
    // intermediate states would be bigger, slower and no more true.
    const db = freshDb();
    const id = db.run(`INSERT INTO food (name, is_composite, source, created_at)
                       VALUES ('First', 0, 'starter', 't')`).lastInsertRowid;
    db.run('DELETE FROM change_log');
    db.run('UPDATE food SET name = ? WHERE id = ?', ['Second', id]);
    db.run('UPDATE food SET name = ? WHERE id = ?', ['Third', id]);

    const { changes } = pendingChanges(db);
    expect(changes).toHaveLength(1);
    expect((changes[0].row as { name: string }).name).toBe('Third');
  });

  it('reassembles a composite key to find the row', () => {
    const db = freshDb();
    const food = db.run(`INSERT INTO food (name, is_composite, source, created_at)
                         VALUES ('Multi', 0, 'starter', 't')`).lastInsertRowid;
    db.run('DELETE FROM change_log');
    db.run(`INSERT INTO food_nutrient (food_id, nutrient, per_100g, rel_error)
            VALUES (?,'protein_g',9,0.2)`, [food]);

    const change = pendingChanges(db).changes.find((c) => c.table === 'food_nutrient')!;
    expect(change.row).toMatchObject({ nutrient: 'protein_g', per_100g: 9 });
  });

  it('sends a delete without a row', () => {
    const db = freshDb();
    const id = db.run(`INSERT INTO food (name, is_composite, source, created_at)
                       VALUES ('Doomed', 0, 'starter', 't')`).lastInsertRowid;
    db.run('DELETE FROM change_log');
    db.run('DELETE FROM food WHERE id = ?', [id]);

    const change = pendingChanges(db).changes[0];
    expect(change.op).toBe('delete');
    expect(change.row).toBeUndefined();
    expect(change.rowId).toBe(String(id));
  });

  it('skips a row deleted between the trigger firing and the read', () => {
    // Its own delete change row carries the truth, so dropping the
    // stale upsert loses nothing.
    const db = freshDb();
    const id = db.run(`INSERT INTO food (name, is_composite, source, created_at)
                       VALUES ('Gone', 0, 'starter', 't')`).lastInsertRowid;
    db.run('DELETE FROM change_log');
    db.run('UPDATE food SET name = ? WHERE id = ?', ['Still here', id]);
    db.run('DELETE FROM change_log WHERE op = ?', ['delete']);
    db.exec('PRAGMA foreign_keys = OFF');
    db.run('DELETE FROM food WHERE id = ?', [id]);
    db.run('DELETE FROM change_log WHERE op = ?', ['delete']);

    const { changes } = pendingChanges(db);
    expect(changes.filter((c) => c.table === 'food' && c.rowId === String(id))).toEqual([]);
  });
});

describe('marking a push done', () => {
  it('only marks what was actually sent', () => {
    // The failure this prevents: an edit made DURING the round trip
    // getting marked as pushed and silently never replicated.
    const db = freshDb();
    db.run('DELETE FROM change_log');
    const a = db.run(`INSERT INTO food (name, is_composite, source, created_at)
                      VALUES ('A', 0, 'starter', 't')`).lastInsertRowid;
    const sent = pendingChanges(db).changes.map((c) => c.seq);

    // ...meanwhile, another write lands.
    db.run(`INSERT INTO food (name, is_composite, source, created_at)
            VALUES ('B', 0, 'starter', 't')`);

    markPushed(db, sent);
    const still = pendingChanges(db).changes;
    expect(still).toHaveLength(1);
    expect((still[0].row as { name: string }).name).toBe('B');
    expect(a).toBeGreaterThan(0);
  });

  it('reports how far behind the replica is', () => {
    const db = freshDb();
    db.run('DELETE FROM change_log');
    expect(replicaLag(db).pending).toBe(0);
    db.run(`INSERT INTO food (name, is_composite, source, created_at)
            VALUES ('Late', 0, 'starter', 't')`);
    expect(replicaLag(db).pending).toBe(1);
    markPushed(db, pendingChanges(db).changes.map((c) => c.seq));
    expect(replicaLag(db).pending).toBe(0);
  });

  it('prunes what has already been carried, and nothing else', () => {
    const db = freshDb();
    db.run('DELETE FROM change_log');
    for (let i = 0; i < 30; i++) {
      db.run(`INSERT INTO food (name, is_composite, source, created_at)
              VALUES (?, 0, 'starter', 't')`, [`F${i}`]);
    }
    markPushed(db, pendingChanges(db).changes.map((c) => c.seq));
    db.run(`INSERT INTO food (name, is_composite, source, created_at)
            VALUES ('Pending', 0, 'starter', 't')`);

    pruneChangeLog(db, 5);
    const left = db.all<{ pushed_at: string | null }>('SELECT pushed_at FROM change_log');
    // The unpushed one survives, whatever the retention.
    expect(left.filter((r) => r.pushed_at === null)).toHaveLength(1);
    expect(left.length).toBeLessThan(31);
  });

  it('can queue the entire database for a replica that was emptied', () => {
    const db = freshDb();
    db.run(`INSERT INTO food (name, is_composite, source, created_at)
            VALUES ('Keep', 0, 'starter', 't')`);
    markPushed(db, pendingChanges(db).changes.map((c) => c.seq));
    expect(replicaLag(db).pending).toBe(0);

    markEverythingPending(db);
    const pending = pendingChanges(db, 5000).changes;
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.some((c) => c.table === 'food')).toBe(true);
    // Still never the credential.
    expect(pending.some((c) => c.table === 'app_secret')).toBe(false);
  });
});
