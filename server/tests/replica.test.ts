import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyPush, REPLICATED, validatePush } from '../src/replica.ts';
import type { Supabase } from '../src/supabase.ts';

/**
 * This server holds a service key that bypasses row-level security on
 * the entire replica. A push that reached PostgREST unchecked would let
 * anything past the bearer token write any table it liked. Most of this
 * file is about that.
 */

const fakeClient = () => {
  const calls: Array<{ kind: string; table: string; n: number; onConflict?: string[] }> = [];
  return {
    calls,
    client: {
      upsert: async (table: string, rows: unknown[], onConflict: string[]) => {
        calls.push({ kind: 'upsert', table, n: rows.length, onConflict });
      },
      remove: async (table: string, keys: unknown[]) => {
        calls.push({ kind: 'delete', table, n: keys.length });
      },
    } as unknown as Supabase,
  };
};

const upsert = (table: string, rowId: string, row: Record<string, unknown>) =>
  ({ changes: [{ table, rowId, op: 'upsert', row }] });

describe('what a push is allowed to say', () => {
  it('accepts a well-formed change', () => {
    const out = validatePush(upsert('log_entry', '7', { id: 7, status: 'resolved' }));
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({ table: 'log_entry', op: 'upsert' });
  });

  it('refuses a table it does not replicate', () => {
    // A table name arriving from a request body and reaching PostgREST
    // is how a data store gets rewritten by a stray fetch.
    expect(validatePush(upsert('pg_catalog.pg_user', '1', { a: 1 }))).toBeNull();
    expect(validatePush(upsert('users', '1', { a: 1 }))).toBeNull();
  });

  it('refuses the credential table by name', () => {
    // Belt and braces: app_secret has no trigger and no upstream table,
    // and it is also not in the allowlist.
    expect(validatePush(upsert('app_secret', 'sync_token', { value: 'x' }))).toBeNull();
    expect(Object.hasOwn(REPLICATED, 'app_secret')).toBe(false);
  });

  it('refuses a column name that is not a plain identifier', () => {
    expect(validatePush(upsert('food', '1', { 'name; DROP TABLE food': 'x' }))).toBeNull();
    expect(validatePush(upsert('food', '1', { 'a b': 1 }))).toBeNull();
    expect(validatePush(upsert('food', '1', { 'Name': 1 }))).toBeNull();
  });

  it('refuses a nested value, which cannot be a column', () => {
    expect(validatePush(upsert('food', '1', { name: { $ne: null } }))).toBeNull();
    expect(validatePush(upsert('food', '1', { name: ['a'] }))).toBeNull();
  });

  it('refuses an upsert with no row, and a change with no id', () => {
    expect(validatePush({ changes: [{ table: 'food', rowId: '1', op: 'upsert' }] })).toBeNull();
    expect(validatePush({ changes: [{ table: 'food', rowId: '', op: 'delete' }] })).toBeNull();
  });

  it('refuses anything that is not a list of changes', () => {
    for (const bad of [null, 'changes', 42, {}, { changes: 'no' }, { changes: [1] }]) {
      expect(validatePush(bad)).toBeNull();
    }
  });

  it('allows null, which is how a missing measurement is stored', () => {
    const out = validatePush(upsert('log_entry', '1', { id: 1, grams_resolved: null }));
    expect(out).toHaveLength(1);
  });
});

describe('applying a push', () => {
  it('groups by table, so a hundred entries are one request', () => {
    const { client, calls } = fakeClient();
    const changes = validatePush({
      changes: Array.from({ length: 100 }, (_, i) => ({
        table: 'log_entry', rowId: String(i), op: 'upsert', row: { id: i },
      })),
    })!;
    return applyPush(client, changes).then((r) => {
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ kind: 'upsert', table: 'log_entry', n: 100 });
      expect(r.upserted).toBe(100);
    });
  });

  it('names the primary key as the conflict target', async () => {
    // Guessing it wrong turns every sync into a duplicate-key error,
    // and PostgREST does not say which table.
    const { client, calls } = fakeClient();
    await applyPush(client, validatePush({
      changes: [{ table: 'daily_metric', rowId: '2026-08-24|steps|garmin', op: 'upsert',
        row: { log_date: '2026-08-24', metric: 'steps', source: 'garmin', value: 8000 } }],
    })!);
    expect(calls[0].onConflict).toEqual(['log_date', 'metric', 'source']);
  });

  it('upserts before it deletes, so a delete is not undone', async () => {
    const { client, calls } = fakeClient();
    await applyPush(client, validatePush({
      changes: [
        { table: 'food', rowId: '2', op: 'delete' },
        { table: 'food', rowId: '1', op: 'upsert', row: { id: 1 } },
      ],
    })!);
    expect(calls.map((c) => c.kind)).toEqual(['upsert', 'delete']);
  });

  it('splits a composite rowId back into its key columns', async () => {
    const { client, calls } = fakeClient();
    await applyPush(client, validatePush({
      changes: [{ table: 'food_nutrient', rowId: '5|protein_g', op: 'delete' }],
    })!);
    expect(calls[0]).toMatchObject({ kind: 'delete', table: 'food_nutrient', n: 1 });
  });

  it('drops a delete whose id cannot address a row', async () => {
    // Guessing the missing half of a composite key would delete the
    // wrong row, which is worse than not deleting at all.
    const { client, calls } = fakeClient();
    const r = await applyPush(client, validatePush({
      changes: [{ table: 'food_nutrient', rowId: '5', op: 'delete' }],
    })!);
    expect(calls).toHaveLength(0);
    expect(r.deleted).toBe(0);
  });
});

describe('the allowlist agrees with the schema', () => {
  it('names exactly the tables the local schema replicates', () => {
    // Two lists that must agree, so they are checked rather than
    // maintained: a table added locally but missing here would fail
    // every push with "malformed", which reads like a client bug.
    const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
    const triggered = [...new Set(
      [...schema.matchAll(/CREATE TRIGGER IF NOT EXISTS trg_(\w+?)_(?:insert|update|delete)_repl/g)]
        .map((m) => m[1]))].sort();
    expect(Object.keys(REPLICATED).sort()).toEqual(triggered);
  });

  it('states the REAL primary key for every table it allows', () => {
    // Not just "a" key. Both this list and the triggers were written by
    // hand first and both guessed wrong - capture_timing has no `id`
    // column at all, and a wrong conflict target turns every push into
    // a duplicate-key error that does not say which table.
    const schema = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');
    for (const [table, key] of Object.entries(REPLICATED)) {
      expect(key.length, table).toBeGreaterThan(0);
      const trigger = new RegExp(
        `trg_${table}_insert_repl[\\s\\S]*?VALUES \\('${table}', ([^,]+),`).exec(schema);
      expect(trigger, `no trigger for ${table}`).not.toBeNull();
      for (const col of key) {
        expect(trigger![1], `${table} key`).toContain(`NEW.${col}`);
      }
    }
  });
});
