import { createRequire } from 'node:module';
import type { Db, Param, Row } from '../core/db';

// node:sqlite is still flagged experimental, which means it is absent from
// module.builtinModules and every bundler tries to resolve it from disk.
// Assembling the specifier at runtime keeps it out of the static graph —
// this file is node-only anyway; the browser uses browser-db.ts.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:' + 'sqlite') as {
  DatabaseSync: new (path: string) => any;
};

/**
 * node:sqlite adapter. Used by the test suite and the loader scripts.
 * The browser runs the same core logic against sqlite-wasm; keeping both
 * behind one interface is what lets the parser and resolver be tested at
 * all, since neither can run inside a headless browser quickly.
 */
export class NodeDb implements Db {
  private db: any;
  private depth = 0;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  exec(sql: string): void { this.db.exec(sql); }

  all<T = Row>(sql: string, params: Param[] = []): T[] {
    return this.db.prepare(sql).all(...(params as any)) as T[];
  }

  get<T = Row>(sql: string, params: Param[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as any)) as T | undefined;
  }

  run(sql: string, params: Param[] = []) {
    const r = this.db.prepare(sql).run(...(params as any));
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  /** Nestable: inner calls join the outer transaction via savepoints. */
  tx<T>(fn: () => T): T {
    const name = `sp_${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return out;
    } catch (e) {
      this.depth--;
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
      throw e;
    }
  }

  close(): void { this.db.close(); }
}
