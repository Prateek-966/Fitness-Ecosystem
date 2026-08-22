import type { Db } from './db';

/**
 * Tunables live in app_setting, never in this file.
 *
 * FUZZY_THRESHOLD is a placeholder, not a tuned value. A placeholder
 * you have to redeploy to change is a placeholder forever.
 */

export const DEFAULTS = {
  fuzzy_threshold: 0.82,
  auto_learn_threshold: 0.93,
  min_match_margin: 0.05,
  undo_window_ms: 5000,
  target_capture_ms: 3000,
} as const;

export type SettingKey = keyof typeof DEFAULTS;

export function getSetting(db: Db, key: SettingKey): number {
  const row = db.get<{ value: string }>(
    'SELECT value FROM app_setting WHERE key = ?',
    [key],
  );
  if (!row) return DEFAULTS[key];
  const n = Number(row.value);
  return Number.isFinite(n) ? n : DEFAULTS[key];
}

export function setSetting(db: Db, key: SettingKey, value: number): void {
  db.run(
    `INSERT INTO app_setting (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)],
  );
}

export function allSettings(db: Db): Record<SettingKey, number> {
  const out = { ...DEFAULTS } as Record<SettingKey, number>;
  for (const k of Object.keys(DEFAULTS) as SettingKey[]) out[k] = getSetting(db, k);
  return out;
}
