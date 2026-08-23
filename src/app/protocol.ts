import type { Diagnostics } from '../core/stats';
import type { DayEntry, DayTotals, OrphanItem, PendingItem } from '../core/totals';
import type { SettingKey } from '../core/settings';
import type { FoodSource } from '../core/foodimport';
import type { UtteranceOutcome } from '../core/resolve';
import type { SourceCoverage } from '../core/garmin';
import type { SlotWindow } from '../core/mealslot';
import type {
  ActiveTarget, BodyProfile, MacroBudget, MealTarget, TargetSource, WeightProgress,
} from '../core/energy';
import type { DayPlan } from '../core/cycling';
import type { SyncStatus } from '../core/sync';

/**
 * Everything the UI needs to draw itself, fetched in one round trip.
 *
 * The database lives in a worker (OPFS sync access handles exist only
 * there), so each extra query would be another postMessage. Rendering from
 * a single snapshot keeps the UI code synchronous and keeps the number of
 * hops on the capture path at exactly one.
 */
export interface Snapshot {
  date: string;
  totals: DayTotals;
  entries: DayEntry[];
  pending: PendingItem[];
  orphanItems: OrphanItem[];
  units: Array<{ id: number; code: string; is_absolute: number; grams: number | null }>;
  diagnostics: Diagnostics;
  settings: Record<SettingKey, number>;
  indexSize: number;
  foodCount: number;
  /** Which body-data sources exist and over what span. Empty until imported. */
  sourceCoverage: SourceCoverage[];
  /** Derived from your own timestamps. Empty until there is enough of them. */
  mealWindows: SlotWindow[];
  /** Goal setting. Null profile means it has never been set up. */
  profile: BodyProfile | null;
  target: ActiveTarget | null;
  targetSpread: Array<{ source: TargetSource; kcal: number; basis: string | null }>;
  mealTargets: MealTarget[];
  macros: MacroBudget | null;
  weight: WeightProgress | null;
  /** The current cycled week, if one has been planned. */
  weekPlan: DayPlan[];
  /** Today's actuals for the non-food goals. */
  stepsToday: number | null;
  waterToday: number;
  /** Garmin auto-sync. Null status means no token is set. */
  syncConfigured: boolean;
  syncStatus: SyncStatus | null;
  syncLastPulled: string | null;
  syncError: string | null;
  persistent: boolean;
}

export interface LogResult {
  outcome: UtteranceOutcome & { totalMs: number };
  snapshot: Snapshot;
}

export type Request =
  | { method: 'boot' }
  | { method: 'snapshot' }
  | { method: 'log'; transcript: string; micTap: number; sttReturned: number;
      confidence: number | null; mealSlot?: string | null }
  | { method: 'undo'; utteranceId: number }
  | { method: 'revise'; entryId: number; field: string; value: string | number | null; reason: string }
  | { method: 'resolveSlowPath'; utteranceId: number; phrase: string; foodId: number;
      quantity: number | null; unitId: number | null; eatenAt: string }
  | { method: 'recalibrate'; unitId: number; foodId: number | null; grams: number;
      basis: 'weighed' | 'estimated' }
  | { method: 'setSetting'; key: SettingKey; value: number }
  | { method: 'searchFoods'; q: string }
  | { method: 'importFood'; csv: string; source: FoodSource }
  | { method: 'importHealthify'; csv: string }
  | { method: 'importGarmin'; csv: string }
  | { method: 'saveProfile'; profile: BodyProfile }
  | { method: 'setManualTarget'; kcal: number | null }
  | { method: 'planWeek' }
  | { method: 'clearPlan' }
  | { method: 'logWater'; glasses: number }
  | { method: 'setSyncToken'; token: string | null }
  | { method: 'syncNow' }
  | { method: 'exportDb' };

export interface Envelope { id: number; req: Request }
export type Reply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
