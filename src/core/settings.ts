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

  // Macronutrient split, percent of energy. 20/50/30 is the "balanced"
  // preset commercial trackers ship; it is a convention, not a finding,
  // which is exactly why it lives in data you can change.
  macro_protein_pct: 20,
  macro_carb_pct: 50,
  macro_fat_pct: 30,
  // Fibre scales with intake rather than being a flat number: 14 g per
  // 1000 kcal is the long-standing dietary reference.
  fibre_g_per_1000kcal: 14,

  water_goal_glasses: 8,
  steps_goal: 10000,

  // 0 disables calorie cycling and keeps the flat daily line.
  max_cycle_swing: 0.2,
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
