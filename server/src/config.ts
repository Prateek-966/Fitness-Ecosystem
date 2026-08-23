/**
 * Configuration, validated at startup.
 *
 * Everything that could leak health data is checked before the server
 * accepts a single connection. A misconfiguration should stop the process,
 * not produce a running service that is quietly open.
 */

export interface Config {
  port: number;
  syncToken: string;
  garmin: { email: string; password: string } | null;
  adapter: 'connect' | 'fake';
  intervalMin: number;
  dbPath: string;
  staticDir: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const syncToken = env.SYNC_TOKEN?.trim() ?? '';

  // No default, no generated fallback. A public URL that serves someone's
  // sleep and heart-rate history to any unauthenticated caller is not a
  // thing to make easy to reach by accident.
  if (!syncToken) {
    throw new ConfigError(
      'SYNC_TOKEN is required. Generate one with: openssl rand -hex 32');
  }
  if (syncToken.length < 24) {
    throw new ConfigError('SYNC_TOKEN must be at least 24 characters');
  }

  const email = env.GARMIN_EMAIL?.trim();
  const password = env.GARMIN_PASSWORD ?? '';
  const adapter = (env.GARMIN_ADAPTER?.trim() || 'connect') as 'connect' | 'fake';
  if (adapter !== 'connect' && adapter !== 'fake') {
    throw new ConfigError(`GARMIN_ADAPTER must be 'connect' or 'fake', got '${adapter}'`);
  }

  const intervalMin = Number(env.SYNC_INTERVAL_MIN ?? 180);
  if (!Number.isFinite(intervalMin) || intervalMin < 15) {
    // Garmin publishes daily summaries a few times a day. Polling faster
    // earns nothing and spends goodwill with their rate limiter.
    throw new ConfigError('SYNC_INTERVAL_MIN must be a number >= 15');
  }

  return {
    port: Number(env.PORT ?? 10000),
    syncToken,
    garmin: email && password ? { email, password } : null,
    adapter,
    intervalMin,
    dbPath: env.SYNC_DB?.trim() || './data/sync.sqlite3',
    staticDir: env.STATIC_DIR?.trim() || './dist',
  };
}

/** Constant-time compare, so a wrong token cannot be found byte by byte. */
export function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
