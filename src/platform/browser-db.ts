import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Db, Param, Row } from '../core/db';

/**
 * SQLite compiled to WASM, persisted in OPFS.
 *
 * The VFS is opfs-sahpool rather than the plain opfs VFS: it needs no
 * COOP/COEP headers, which means this runs from any static host and can be
 * installed to a phone home screen without a store listing. That is the
 * whole reason the stack was chosen — time to first real log.
 *
 * Every method is synchronous. The capture write must not yield.
 */

let sqlite3: any = null;
let poolUtil: any = null;

export interface OpenResult {
  db: BrowserDb;
  persistent: boolean;
}

export async function openDatabase(filename = 'nutrition.sqlite3'): Promise<OpenResult> {
  if (!sqlite3) sqlite3 = await sqlite3InitModule();

  if (!poolUtil) {
    try {
      poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: 'nutrition-opfs' });
    } catch {
      poolUtil = null;
    }
  }

  if (poolUtil) {
    return { db: new BrowserDb(new poolUtil.OpfsSAHPoolDb(`/${filename}`)), persistent: true };
  }
  // No OPFS (private window, unsupported browser). Still runs, still logs,
  // but the user is told rather than silently losing a day of entries.
  return { db: new BrowserDb(new sqlite3.oo1.DB(':memory:', 'c')), persistent: false };
}

export class BrowserDb implements Db {
  private depth = 0;
  constructor(private handle: any) {
    this.handle.exec('PRAGMA foreign_keys = ON');
  }

  exec(sql: string): void { this.handle.exec(sql); }

  all<T = Row>(sql: string, params: Param[] = []): T[] {
    return this.handle.exec({
      sql, bind: params as any, rowMode: 'object', returnValue: 'resultRows',
    }) as T[];
  }

  get<T = Row>(sql: string, params: Param[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  run(sql: string, params: Param[] = []) {
    this.handle.exec({ sql, bind: params as any });
    return {
      lastInsertRowid: Number(this.handle.selectValue('SELECT last_insert_rowid()')),
      changes: Number(this.handle.selectValue('SELECT changes()')),
    };
  }

  tx<T>(fn: () => T): T {
    const name = `sp_${this.depth}`;
    this.handle.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.handle.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return out;
    } catch (e) {
      this.depth--;
      this.handle.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
      throw e;
    }
  }

  /** Whole-database export, for the manual backup button. */
  export(): Uint8Array {
    return sqlite3.capi.sqlite3_js_db_export(this.handle);
  }

  close(): void { this.handle.close(); }
}
