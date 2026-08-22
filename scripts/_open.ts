import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NodeDb } from '../src/platform/node-db';
import { initSchema, type Db } from '../src/core/db';

const ROOT = new URL('..', import.meta.url);
const SCHEMA = readFileSync(new URL('db/schema.sql', ROOT), 'utf8');
const SEED = readFileSync(new URL('db/seed.sql', ROOT), 'utf8');

/**
 * The CLI database lives in ./data, which is gitignored. Nothing derived
 * from a licensed source is ever supposed to reach the repository.
 */
export function openCliDb(path = process.env.LOG_DB ?? 'data/nutrition.sqlite3'): Db {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new NodeDb(abs);
  initSchema(db, SCHEMA, SEED);
  return db;
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function positional(n = 0): string | undefined {
  return process.argv.slice(2).filter((a) => !a.startsWith('--'))[n];
}
