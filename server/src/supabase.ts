/**
 * A PostgREST client, in about a hundred lines.
 *
 * No @supabase/supabase-js. The server has no dependencies at all -
 * node:http and node:sqlite are built in - and the whole of what this
 * needs from Supabase is "upsert these rows" and "delete these rows",
 * which is two fetch calls. Nothing to install means nothing to audit.
 *
 * THE SERVICE KEY LIVES HERE AND ONLY HERE. It bypasses row-level
 * security, so a browser holding it could read and rewrite the entire
 * replica. The browser therefore never sees it: the app posts changes
 * to /api/replica on its own origin with the bearer token it already
 * has, and this file is what talks to Supabase. That also keeps
 * connect-src 'self' intact - no CSP widening, no second host.
 */

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export class SupabaseError extends Error {
  readonly status: number;
  constructor(what: string, status: number, detail: string) {
    super(`Supabase ${what} failed (HTTP ${status}): ${detail}`);
    this.status = status;
  }
}

export class Supabase {
  private url: string;
  private key: string;

  constructor(cfg: SupabaseConfig) {
    // Trailing slash makes every path double up; strip once here rather
    // than at each call site.
    this.url = cfg.url.replace(/\/+$/, '');
    this.key = cfg.serviceKey;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  /**
   * Upsert rows into one table.
   *
   * `onConflict` names the primary key so Postgres updates rather than
   * rejecting. It is passed explicitly rather than inferred, because
   * guessing it wrong turns an update into a duplicate-key error on
   * every single sync and the message does not say which table.
   */
  async upsert(table: string, rows: Array<Record<string, unknown>>,
    onConflict: string[]): Promise<void> {
    if (rows.length === 0) return;
    const query = new URLSearchParams({ on_conflict: onConflict.join(',') });
    const res = await this.call('upsert', `/rest/v1/${table}?${query}`, {
      method: 'POST',
      headers: this.headers({
        // merge-duplicates is the upsert; return=minimal keeps the
        // response empty, which matters when pushing thousands of rows.
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify(rows),
    });
    await res.text();
  }

  /** Delete by primary key. Composite keys are matched on every column. */
  async remove(table: string, keys: Array<Record<string, unknown>>): Promise<void> {
    for (const key of keys) {
      const query = new URLSearchParams();
      for (const [col, value] of Object.entries(key)) {
        query.append(col, `eq.${String(value)}`);
      }
      const res = await this.call('delete', `/rest/v1/${table}?${query}`, {
        method: 'DELETE',
        headers: this.headers({ Prefer: 'return=minimal' }),
      });
      await res.text();
    }
  }

  /** Cheapest call that proves the credential and the schema both work. */
  async check(table = 'log_entry'): Promise<void> {
    const res = await this.call('check', `/rest/v1/${table}?select=1&limit=1`, {
      headers: this.headers(),
    });
    await res.text();
  }

  private async call(what: string, path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, init);
    } catch (e) {
      throw new SupabaseError(what, 0, `network error: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) {
      // PostgREST puts a genuinely useful message in the body; losing it
      // leaves you with a bare status and a schema you cannot debug.
      const detail = await res.text().catch(() => '');
      throw new SupabaseError(what, res.status, detail.slice(0, 400));
    }
    return res;
  }
}
