import type {
  Envelope, LogResult, Reply, Request, Snapshot,
} from './protocol';
import type { SettingKey } from '../core/settings';
import type { FoodSource } from '../core/foodimport';
import type { LoadReport } from '../core/foodimport';
import type { ImportReport } from '../core/healthify';
import type { GarminReport } from '../core/garmin';
import type { BodyProfile } from '../core/energy';

/**
 * Main-thread handle on the database worker.
 *
 * Every call is one round trip and every mutation returns a fresh
 * snapshot, so the UI never has to ask twice and never renders a view
 * assembled from two different moments.
 */
export class Store {
  private worker: Worker;
  private seq = 0;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private current!: Snapshot;

  private constructor() {
    this.worker = new Worker(new URL('../worker/db-worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (ev: MessageEvent<Reply>) => {
      const pending = this.waiting.get(ev.data.id);
      if (!pending) return;
      this.waiting.delete(ev.data.id);
      if (ev.data.ok) pending.ok(ev.data.result);
      else pending.fail(new Error(ev.data.error));
    };
    this.worker.onerror = (ev) => {
      for (const p of this.waiting.values()) p.fail(new Error(ev.message || 'worker failed'));
      this.waiting.clear();
    };
  }

  static async open(): Promise<Store> {
    const s = new Store();
    s.current = await s.send<Snapshot>({ method: 'boot' });
    return s;
  }

  private send<T>(req: Request): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.worker.postMessage({ id, req } satisfies Envelope);
    });
  }

  /** The snapshot the UI is currently drawn from. */
  get snapshot(): Snapshot { return this.current; }

  private adopt<T extends { snapshot: Snapshot }>(r: T): T {
    this.current = r.snapshot;
    return r;
  }

  async refresh(): Promise<Snapshot> {
    this.current = await this.send<Snapshot>({ method: 'snapshot' });
    return this.current;
  }

  async log(
    transcript: string,
    o: { micTap: number; sttReturned: number; confidence: number | null; mealSlot?: string | null },
  ): Promise<LogResult['outcome']> {
    const r = this.adopt(await this.send<LogResult>({
      method: 'log', transcript, micTap: o.micTap, sttReturned: o.sttReturned,
      confidence: o.confidence, mealSlot: o.mealSlot ?? null,
    }));
    return r.outcome;
  }

  async undo(utteranceId: number): Promise<void> {
    this.current = await this.send<Snapshot>({ method: 'undo', utteranceId });
  }

  async revise(
    entryId: number, field: string, value: string | number | null, reason: string,
  ): Promise<void> {
    this.current = await this.send<Snapshot>({ method: 'revise', entryId, field, value, reason });
  }

  async resolveSlowPath(a: {
    utteranceId: number; phrase: string; foodId: number;
    quantity: number | null; unitId: number | null; eatenAt: Date;
  }): Promise<void> {
    this.current = await this.send<Snapshot>({
      method: 'resolveSlowPath', ...a, eatenAt: a.eatenAt.toISOString(),
    });
  }

  async recalibrate(
    unitId: number, foodId: number | null, grams: number, basis: 'weighed' | 'estimated',
  ): Promise<number> {
    const r = this.adopt(await this.send<{ revised: number; snapshot: Snapshot }>({
      method: 'recalibrate', unitId, foodId, grams, basis,
    }));
    return r.revised;
  }

  async setSetting(key: SettingKey, value: number): Promise<void> {
    this.current = await this.send<Snapshot>({ method: 'setSetting', key, value });
  }

  searchFoods(q: string) {
    return this.send<Array<{
      id: number; name: string; brand: string | null; source: string;
      kcal: number | null;
    }>>({ method: 'searchFoods', q });
  }

  async importFoodCsv(csv: string, source: FoodSource): Promise<LoadReport & { unmapped: string[] }> {
    const r = this.adopt(await this.send<{ report: LoadReport & { unmapped: string[] }; snapshot: Snapshot }>(
      { method: 'importFood', csv, source },
    ));
    return r.report;
  }

  async importHealthifyCsv(csv: string): Promise<ImportReport> {
    const r = this.adopt(await this.send<{ report: ImportReport; snapshot: Snapshot }>(
      { method: 'importHealthify', csv },
    ));
    return r.report;
  }

  async importGarminCsv(csv: string): Promise<GarminReport> {
    const r = this.adopt(await this.send<{ report: GarminReport; snapshot: Snapshot }>(
      { method: 'importGarmin', csv },
    ));
    return r.report;
  }

  async saveProfile(profile: BodyProfile): Promise<void> {
    this.current = await this.send<Snapshot>({ method: 'saveProfile', profile });
  }

  async setManualTarget(kcal: number | null): Promise<void> {
    this.current = await this.send<Snapshot>({ method: 'setManualTarget', kcal });
  }

  async planWeek(): Promise<void> {
    this.current = await this.send<Snapshot>({ method: 'planWeek' });
  }

  async clearPlan(): Promise<void> {
    this.current = await this.send<Snapshot>({ method: 'clearPlan' });
  }

  async logWater(glasses: number): Promise<void> {
    this.current = await this.send<Snapshot>({ method: 'logWater', glasses });
  }

  async setSyncToken(token: string | null): Promise<void> {
    this.current = await this.send<Snapshot>({ method: 'setSyncToken', token });
  }

  async syncNow(): Promise<{ activities: number; metricRows: number; since: string } | null> {
    const r = this.adopt(await this.send<{
      outcome: { activities: number; metricRows: number; since: string } | null;
      snapshot: Snapshot;
    }>({ method: 'syncNow' }));
    return r.outcome;
  }

  exportBytes(): Promise<Uint8Array | null> {
    return this.send<Uint8Array | null>({ method: 'exportDb' });
  }
}
