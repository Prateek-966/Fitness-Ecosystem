import type { Store } from './store';
import type { Snapshot } from './protocol';
import { h, fmt } from './dom';
import { field, sheet } from './sheet';
import { toast } from './toast';
import { normalise, parse } from '../core/parse';
import {
  ACTIVITY_LEVELS, GOAL_RATES, MACRO_PRESETS, estimateTargets, rateForGoal,
  safetyCheck, type BodyProfile, type Sex,
} from '../core/energy';

/** Views draw from one snapshot; mutations go to the worker and hand back a new one. */
export type Rerender = () => void;
type Ctx = {
  store: Store;
  snap: Snapshot;
  rerender: Rerender;
  /** Focus capture on a given meal slot. Supplied by main.ts. */
  onAddTo?: (slot: string | null) => void;
  /** Switch tab. Supplied by main.ts; only the first-run notice uses it. */
  go?: (to: string) => void;
};

const after = (ctx: Ctx, p: Promise<unknown>, msg: string) =>
  p.then(() => { ctx.rerender(); toast(msg); })
   .catch((e: Error) => toast(e.message, { tone: 'error' }));

// ------------------------------------------------------------------
// TODAY
//
// Grouped by meal, because that is how a day is actually remembered.
// The sections are YOUR meal windows, clustered from when you really
// log - not a schedule this app decided you keep.
//
// What each section shows is what you ate. There is deliberately no
// "0 of 612 Cal": a per-meal target is a decision made for you, and a
// zero for a meal you have not logged yet is the silent under-count this
// whole design exists to prevent.
// ------------------------------------------------------------------
export function todayView(ctx: Ctx): HTMLElement {
  const { totals, entries, mealWindows } = ctx.snap;
  const find = (n: string) => totals.nutrients.find((x) => x.nutrient === n);
  const kcal = find('kcal');

  const target = ctx.snap.target;
  const eaten = kcal?.total ?? 0;

  const head = h('div', { class: 'card intake' },
    h('div', { class: 'intake-main' },
      h('div', {},
        h('div', { class: 'label', text: target ? 'Eaten of target' : 'Intake index' }),
        h('div', { class: 'intake-value' },
          fmt.kcal(eaten),
          target ? h('span', { class: 'of-target', text: ` of ${fmt.kcal(target.kcal)}` }) : null),
        h('div', { class: 'err', text: kcal
          ? `plus or minus ${fmt.kcal(kcal.absError)}`
          : 'nothing logged yet' })),
      h('div', { class: 'macro-grid' },
        ...([['protein_g', 'proteinG'], ['carb_g', 'carbG'], ['fat_g', 'fatG']] as const)
          .map(([nutrient, budgetKey]) => {
            const m = find(nutrient);
            const budget = ctx.snap.macros?.[budgetKey] ?? null;
            return h('div', { class: 'macro' },
              h('div', { class: 'macro-name', text: nutrient.replace('_g', '') }),
              h('div', { class: 'macro-value', text: budget === null
                ? (m ? `${Math.round(m.total)} g` : '—')
                : `${Math.round(m?.total ?? 0)}/${budget}` }));
          }))));

  if (target) {
    const pct = Math.max(0, Math.min(1, target.kcal > 0 ? eaten / target.kcal : 0));
    head.append(h('div', { class: 'bar' },
      h('div', { class: 'bar-fill', style: `width:${(pct * 100).toFixed(1)}%` })));
    head.append(h('div', { class: 'sub', text:
      eaten <= target.kcal
        ? `${fmt.kcal(target.kcal - eaten)} left · target from ${target.source}`
        : `${fmt.kcal(eaten - target.kcal)} over · target from ${target.source}` }));
  }

  if (!totals.complete) {
    head.append(h('div', { class: 'incomplete' },
      `${totals.pendingCount} ${totals.pendingCount === 1 ? 'entry is' : 'entries are'} missing `
      + 'an amount, so this total is low and today is excluded from the model. '
      + 'Clear the queue to close it.'));
  }

  const wrap = h('div', {}, head);

  // No food reference data means nothing can resolve, and the screen
  // that results looks identical to a quiet day. Saying so is not
  // onboarding - there is no wizard here and no dismiss button, just
  // the app being honest about why it cannot work yet. It disappears
  // the moment a food file is loaded.
  if (ctx.snap.foodCount === 0) {
    wrap.append(h('div', { class: 'card empty-first-run' },
      h('div', { class: 'label', text: 'No food data loaded' }),
      h('p', { text:
        'Nothing can be logged until the app knows some foods. No food '
        + 'database ships with it, because none of them are yours to '
        + 'redistribute.' }),
      h('p', { text:
        'Open Diagnostics and load a CSV with columns food_code, '
        + 'food_name, energy_kcal, protein, fat, carbohydrate. Then weigh '
        + 'your katori and your glass once, under Measures.' }),
      h('button', {
        class: 'btn primary',
        text: 'Open Diagnostics',
        onclick: () => ctx.go?.('diagnostics'),
      })));
  }

  // Section order comes from the derived centres, so the day reads in the
  // order you actually eat rather than in an order chosen for you.
  const ordered = [...mealWindows].sort((a, b) => a.centreMin - b.centreMin);
  const bySlot = new Map<string, typeof entries>();
  for (const e of entries) {
    const key = e.mealSlot ?? '__unsorted';
    const list = bySlot.get(key) ?? [];
    list.push(e);
    bySlot.set(key, list);
  }

  if (ordered.length === 0) {
    // No windows derived yet. Show one honest list rather than inventing
    // breakfast/lunch/dinner boundaries this app has not earned.
    wrap.append(mealSection(ctx, null, entries, null));
  } else {
    for (const w of ordered) {
      wrap.append(mealSection(ctx, w.slot, bySlot.get(w.slot) ?? [], w));
    }
    const unsorted = bySlot.get('__unsorted') ?? [];
    if (unsorted.length) wrap.append(mealSection(ctx, null, unsorted, null));
  }

  return wrap;
}

const SLOT_LABEL: Record<string, string> = {
  breakfast: 'Breakfast', lunch: 'Lunch', snack: 'Snack', dinner: 'Dinner',
};

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;

function mealSection(
  ctx: Ctx,
  slot: string | null,
  rows: Snapshot['entries'],
  window: Snapshot['mealWindows'][number] | null,
): HTMLElement {
  const kcal = rows.reduce((sum, e) => sum + (e.kcal ?? 0), 0);
  const pending = rows.filter((e) => e.status !== 'resolved').length;
  const mt = slot ? ctx.snap.mealTargets.find((m) => m.slot === slot) : undefined;
  const mealTarget = mt ? mt.kcal : null;

  const header = h('div', { class: 'meal-head' },
    h('div', { class: 'grow' },
      h('div', { class: 'meal-name', text: slot ? SLOT_LABEL[slot] ?? slot : 'Logged' }),
      window
        ? h('div', { class: 'sub mono', text:
            `usually ${hhmm(window.centreMin)}`
            + (mt?.fromHistory ? ' · share from your history' : '') })
        : null),
    h('div', { class: 'meal-kcal', text: mealTarget !== null
      // "0 of 612" is honest once a target exists: 0 is what is logged.
      // Without one it would just be a number invented to sit beside.
      ? `${fmt.kcal(kcal)} of ${fmt.kcal(mealTarget)}`
      : (rows.length ? fmt.kcal(kcal) : '') }),
    h('button', {
      class: 'add', title: slot ? `log to ${SLOT_LABEL[slot] ?? slot}` : 'log',
      text: '+',
      onclick: () => ctx.onAddTo?.(slot),
    }));

  const body = rows.length
    ? h('ul', { class: 'list' }, ...rows.map((e) => entryRow(ctx, e)))
    : h('div', { class: 'empty quiet', text: 'nothing yet' });

  const card = h('div', { class: 'card meal' }, header, body);
  if (pending) {
    card.append(h('div', { class: 'meal-note', text:
      `${pending} not counted yet — needs an amount` }));
  }
  return card;
}

function stat(label: string, value: string, err: string): HTMLElement {
  return h('div', { class: 'stat' },
    h('div', { class: 'label', text: label }),
    h('div', { class: 'value', text: value }),
    h('div', { class: 'err', text: err }));
}

function entryRow(ctx: Ctx, e: Snapshot['entries'][number]): HTMLElement {
  const pills: HTMLElement[] = [];
  if (e.status !== 'resolved') pills.push(h('span', { class: 'pill pending', text: 'needs amount' }));
  else if (e.matchMethod === 'fuzzy_index') {
    pills.push(h('span', {
      class: 'pill fuzzy',
      title: `matched at ${e.matchScore?.toFixed(2)} — worth a glance`,
      text: `~${e.matchScore?.toFixed(2)}`,
    }));
  } else if (e.matchMethod === 'manual') {
    // Covers both a slow-path resolution and a later edit: in each case a
    // person decided this, not the matcher.
    pills.push(h('span', { class: 'pill manual', text: 'by hand' }));
  }

  return h('li', {},
    h('span', { class: 'time', text: fmt.time(e.eatenAt) }),
    h('span', { class: 'grow' },
      h('div', { class: 'name', text: e.foodName }),
      h('div', { class: 'sub', text: `${fmt.qty(e.quantity, e.unitCode)} · ${fmt.grams(e.gramsResolved)}` })),
    ...pills,
    h('span', { class: 'kcal', text: e.kcal === null ? '—' : fmt.kcal(e.kcal) }),
    h('button', { class: 'btn quiet', text: 'edit', onclick: () => editSheet(ctx, e) }));
}

// ------------------------------------------------------------------
// EDIT SHEET — every change goes through log_revision.
// ------------------------------------------------------------------
function editSheet(ctx: Ctx, e: Snapshot['entries'][number]): void {
  const qty = h('input', { type: 'number', step: '0.25', min: '0', value: e.quantity ?? '' });
  const unitSel = unitSelect(ctx, e.unitCode);

  const close = sheet(e.foodName, `logged ${fmt.time(e.eatenAt)}`,
    h('div', {},
      field('Amount', qty),
      field('Unit', unitSel),
      h('p', {
        class: 'hint',
        text: 'Every edit is stored as a revision, not written over the original. That is what '
            + 'later tells a real metabolic change apart from a correction you made.',
      })),
    [
      h('button', { class: 'btn quiet', text: 'Cancel', onclick: () => close() }),
      h('button', {
        class: 'btn primary', text: 'Save',
        onclick: async () => {
          const q = qty.value === '' ? null : Number(qty.value);
          const u = Number(unitSel.value);
          const currentUnit = ctx.snap.units.find((x) => x.code === e.unitCode)?.id ?? null;
          close();
          try {
            if (u !== currentUnit) await ctx.store.revise(e.logEntryId, 'unit_id', u, 'user_edit');
            if (q !== e.quantity) {
              await ctx.store.revise(e.logEntryId, 'quantity', q,
                e.quantity === null ? 'quantity_supplied' : 'user_edit');
            }
            ctx.rerender();
            toast('Saved as a revision.');
          } catch (err) { toast((err as Error).message, { tone: 'error' }); }
        },
      }),
    ]);
}

function unitSelect(ctx: Ctx, selectedCode: string | null): HTMLSelectElement {
  return h('select', {}, ...ctx.snap.units.map((u) => h('option', {
    value: String(u.id),
    selected: u.code === selectedCode ? '' : null,
    text: u.is_absolute
      ? u.code
      : `${u.code}${u.grams ? ` (${Math.round(u.grams)} g)` : ' — not calibrated'}`,
  })));
}

// ------------------------------------------------------------------
// QUEUE — cleared in one end-of-day pass.
// ------------------------------------------------------------------
export function pendingView(ctx: Ctx): HTMLElement {
  const { pending, orphanItems } = ctx.snap;

  return h('div', {},
    h('h2', { text: `Needs an amount (${pending.length})` }),
    h('div', { class: 'card' },
      pending.length
        ? h('ul', { class: 'list' }, ...pending.map((p) => h('li', {},
            h('span', { class: 'time', text: fmt.time(p.eatenAt) }),
            h('span', { class: 'grow' },
              h('div', { class: 'name', text: p.foodName }),
              p.said ? h('div', { class: 'sub', text: `“${p.said}”` }) : null),
            h('button', {
              class: 'btn primary', text: 'Amount',
              onclick: () => quantitySheet(ctx, p),
            }))))
        : h('div', { class: 'empty', text: 'Queue is empty.' })),

    h('h2', { text: `Not recognised (${orphanItems.length})` }),
    h('div', { class: 'card' },
      orphanItems.length
        ? h('ul', { class: 'list' }, ...orphanItems.map((o) => h('li', {},
            h('span', { class: 'time', text: fmt.time(o.spokenAt) }),
            h('span', { class: 'grow' },
              h('div', { class: 'name', text: `“${o.phrase ?? o.rawText}”` }),
              h('div', {
                class: 'sub',
                text: o.phrase && o.phrase !== o.rawText.toLowerCase()
                  ? `from “${o.rawText}” — nothing was guessed`
                  : 'food not recognised — nothing was guessed',
              })),
            h('button', { class: 'btn', text: 'Resolve', onclick: () => slowPathSheet(ctx, o) }))))
        : h('div', { class: 'empty', text: 'Nothing unresolved. Every utterance has an outcome.' })),

    h('p', {
      class: 'hint',
      text: 'Nothing here was guessed at. An unrecognised food is never written to the log, and a '
          + 'recognised food with no amount is never counted as zero.',
    }));
}

function quantitySheet(ctx: Ctx, p: Snapshot['pending'][number]): void {
  const qty = h('input', { type: 'number', step: '0.25', min: '0', autofocus: '' });
  const unitSel = unitSelect(ctx, null);

  const close = sheet(p.foodName, p.said ? `you said “${p.said}”` : null,
    h('div', {}, field('Amount', qty), field('Unit', unitSel)),
    [
      h('button', { class: 'btn quiet', text: 'Cancel', onclick: () => close() }),
      h('button', {
        class: 'btn primary', text: 'Save',
        onclick: async () => {
          if (qty.value === '') return;
          close();
          try {
            await ctx.store.revise(p.id, 'unit_id', Number(unitSel.value), 'quantity_supplied');
            await ctx.store.revise(p.id, 'quantity', Number(qty.value), 'quantity_supplied');
            ctx.rerender();
            toast('Entry completed.');
          } catch (e) { toast((e as Error).message, { tone: 'error' }); }
        },
      }),
    ]);
}

function slowPathSheet(ctx: Ctx, o: Snapshot['orphanItems'][number]): void {
  const search = h('input', { type: 'search', placeholder: 'search foods…', autofocus: '' });
  const results = h('div', {});
  const qty = h('input', { type: 'number', step: '0.25', min: '0', value: '1' });
  const unitSel = unitSelect(ctx, null);
  let chosen: { id: number; name: string } | null = null;

  const renderResults = async () => {
    const q = search.value.trim();
    if (q.length < 2) { results.replaceChildren(); return; }
    const found = await ctx.store.searchFoods(q);
    results.replaceChildren();
    if (!found.length) {
      results.append(h('div', {
        class: 'empty',
        text: 'No match. Load a food database under Diagnostics.',
      }));
      return;
    }
    results.append(h('ul', { class: 'list' }, ...found.map((f) => h('li', {},
      h('span', { class: 'grow' },
        h('div', { class: 'name', text: f.name }),
        h('div', { class: 'sub', text: `${f.brand ?? 'generic'} · ${f.source}` })),
      h('button', {
        class: chosen?.id === f.id ? 'btn primary' : 'btn',
        text: chosen?.id === f.id ? 'selected' : 'pick',
        onclick: () => { chosen = { id: f.id, name: f.name }; void renderResults(); },
      })))));
  };
  search.addEventListener('input', () => void renderResults());

  const close = sheet(`“${o.phrase ?? o.rawText}”`, 'not recognised — nothing was written',
    h('div', {},
      field('What was it?', search), results,
      h('div', { class: 'row' }, field('Amount', qty), field('Unit', unitSel)),
      h('p', {
        class: 'hint',
        text: 'Once you answer this, the phrase joins your index and never comes back here.',
      })),
    [
      h('button', { class: 'btn quiet', text: 'Cancel', onclick: () => close() }),
      h('button', {
        class: 'btn primary', text: 'Log and learn',
        onclick: () => {
          if (!chosen) { toast('Pick a food first.', { tone: 'warn' }); return; }
          close();
          void after(ctx, ctx.store.resolveSlowPath({
            utteranceId: o.utteranceId,
            // The key written here MUST be the key the fast path will look
            // up next time. The parser already produced it for a parsed
            // item; only a parse-to-nothing utterance falls back to
            // normalising the raw transcript.
            phrase: o.phrase ?? indexKey(o.rawText),
            foodId: chosen.id,
            quantity: qty.value === '' ? null : Number(qty.value),
            unitId: Number(unitSel.value),
            eatenAt: new Date(o.spokenAt),
          }), `Learned. “${o.phrase ?? o.rawText}” is instant from now on.`);
        },
      }),
    ]);
}

function indexKey(raw: string): string {
  const items = parse(raw);
  return items.length ? items[0].phrase : normalise(raw);
}

// ------------------------------------------------------------------
// MEASURES — weigh it once, reuse forever.
// ------------------------------------------------------------------
export function calibrateView(ctx: Ctx): HTMLElement {
  const units = ctx.snap.units.filter((u) => !u.is_absolute);

  return h('div', {},
    h('h2', { text: 'Your measures' }),
    h('div', { class: 'card' },
      h('ul', { class: 'list' }, ...units.map((u) => h('li', {},
        h('span', { class: 'grow' },
          h('div', { class: 'name', text: u.code }),
          h('div', { class: 'sub', text: u.grams ? `${Math.round(u.grams)} g` : 'not calibrated' })),
        h('button', {
          class: u.grams ? 'btn' : 'btn primary',
          text: u.grams ? 'change' : 'weigh',
          onclick: () => calibrateSheet(ctx, u),
        }))))),
    h('p', {
      class: 'hint',
      text: 'Accuracy is not the point here. Stability is. A number that never moves beats a '
          + 'population average that happens to be closer to true, because a constant bias '
          + 'cancels out of the model and a wandering one does not.',
    }));
}

function calibrateSheet(ctx: Ctx, u: Snapshot['units'][number]): void {
  const grams = h('input', { type: 'number', step: '1', min: '1', value: u.grams ?? '', autofocus: '' });
  const basis = h('select', {},
    h('option', { value: 'weighed', text: 'I put it on a scale' }),
    h('option', { value: 'estimated', text: 'I estimated it' }));

  const close = sheet(`One ${u.code}`,
    u.grams ? `currently ${Math.round(u.grams)} g` : 'never weighed',
    h('div', {},
      field(`Grams in one ${u.code}`, grams),
      field('How do you know?', basis),
      h('p', {
        class: 'hint',
        text: 'Changing this rewrites every past entry in this unit — each one gets its own '
            + 'revision row, so the change stays visible in the history rather than quietly '
            + 'moving the model’s training data.',
      })),
    [
      h('button', { class: 'btn quiet', text: 'Cancel', onclick: () => close() }),
      h('button', {
        class: 'btn primary', text: 'Save',
        onclick: async () => {
          if (grams.value === '') return;
          close();
          try {
            const n = await ctx.store.recalibrate(
              u.id, null, Number(grams.value), basis.value as 'weighed' | 'estimated');
            ctx.rerender();
            toast(n ? `Saved. ${n} past ${n === 1 ? 'entry' : 'entries'} revised.` : 'Saved.');
          } catch (e) { toast((e as Error).message, { tone: 'error' }); }
        },
      }),
    ]);
}

// ------------------------------------------------------------------
// DIAGNOSTICS — the acceptance criteria, measured.
// ------------------------------------------------------------------
export function diagnosticsView(ctx: Ctx): HTMLElement {
  const d = ctx.snap.diagnostics;
  const s = ctx.snap.settings;

  const criterion = (n: number, text: string, value: string, met: boolean | null) =>
    h('li', {},
      h('span', { class: 'grow' },
        h('div', { class: 'name', text: `${n}. ${text}` }),
        h('div', { class: 'sub mono', text: value })),
      h('span', {
        class: met === null ? 'pill' : met ? 'pill fuzzy' : 'pill pending',
        text: met === null ? 'no data' : met ? 'met' : 'not yet',
      }));

  const wrap = h('div', {},
    h('h2', { text: 'Acceptance criteria' }),
    h('div', { class: 'card' }, h('ul', { class: 'list' },
      criterion(1, 'Known repeat meal logged in under 3 s',
        `median ${fmt.ms(d.medianCaptureMs)} · p90 ${fmt.ms(d.p90CaptureMs)}`,
        d.underTargetFraction === null ? null : d.underTargetFraction >= 0.9),
      criterion(2, 'Fast-path fraction above 0.8', fmt.pct(d.fastpathFraction),
        d.fastpathFraction === null ? null : d.fastpathFraction > 0.8),
      criterion(3, 'Zero logs lost',
        `${d.lostUtterances} lost · ${d.queuedUtterances} waiting in the queue`,
        d.lostUtterances === 0),
      criterion(4, 'Pending queue clearable in a minute', `${d.openPending} open`, d.openPending <= 10),
      criterion(5, '30 consecutive days', `${d.currentStreakDays} day streak`, d.currentStreakDays >= 30))),

    h('h2', { text: 'Personal index' }),
    h('div', { class: 'card' },
      h('div', { class: 'totals' },
        stat('Phrases known', String(ctx.snap.indexSize), 'grows every slow path'),
        stat('Storage', ctx.snap.persistent ? 'OPFS' : 'memory only',
             ctx.snap.persistent ? 'survives reload' : 'NOT persisted')),
      h('div', { class: 'row mt' },
        h('button', {
          class: 'btn', text: 'Export backup (.sqlite3)',
          onclick: async () => {
            // OPFS lives in one browser profile on one device. Months of
            // logs with no copy anywhere else is its own data-loss bug, so
            // the whole database exports as a plain SQLite file.
            try {
              const bytes = await ctx.store.exportBytes();
              if (!bytes) { toast('Export not available in this browser.', { tone: 'warn' }); return; }
              const blob = new Blob([bytes as BlobPart], { type: 'application/vnd.sqlite3' });
              const a = h('a', {
                href: URL.createObjectURL(blob),
                download: `nutrition-${ctx.snap.date}.sqlite3`,
              });
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
              toast('Backup exported.');
            } catch (e) { toast((e as Error).message, { tone: 'error' }); }
          },
        }))));

  if (!ctx.snap.persistent) {
    wrap.append(h('div', { class: 'incomplete' },
      'This browser did not give the app persistent storage, so the database lives in memory and '
      + 'will be gone on reload. Everything still works; nothing is being saved.'));
  }

  wrap.append(h('h2', { text: 'Thresholds' }));
  const settingsCard = h('div', { class: 'card' });
  for (const [key, label, hint] of [
    ['fuzzy_threshold', 'Fuzzy match threshold', 'Below this, the slow path. Start high.'],
    ['auto_learn_threshold', 'Auto-learn threshold', 'Below this, log it but do not index it.'],
    ['min_match_margin', 'Minimum margin over runner-up', 'A near tie is not a match.'],
  ] as const) {
    const input = h('input', { type: 'number', step: '0.01', min: '0', max: '1', value: String(s[key]) });
    input.addEventListener('change', () => {
      void after(ctx, ctx.store.setSetting(key, Number(input.value)), `${label} set to ${input.value}.`);
    });
    settingsCard.append(h('div', { class: 'field' }, h('label', { text: `${label} — ${hint}` }), input));
  }
  wrap.append(settingsCard);

  // ---- food reference data ----
  wrap.append(h('h2', { text: 'Food reference data' }));
  const foodSource = h('select', {},
    h('option', { value: 'indb', text: 'INDB — Indian Nutrient Databank' }),
    h('option', { value: 'ifct2017', text: 'IFCT 2017 (personal use only)' }),
    h('option', { value: 'usda_fdc', text: 'USDA FoodData Central' }),
    h('option', { value: 'label', text: 'Label values' }));
  const foodFile = h('input', { type: 'file', accept: '.csv,text/csv' });
  foodFile.addEventListener('change', async () => {
    const f = foodFile.files?.[0];
    if (!f) return;
    try {
      const r = await ctx.store.importFoodCsv(await f.text(), foodSource.value as any);
      ctx.rerender();
      toast(`${r.inserted} foods added, ${r.updated} updated.`, {
        detail: r.skipped.length ? `${r.skipped.length} had no energy value` : undefined,
      });
    } catch (e) { toast((e as Error).message, { tone: 'error' }); }
  });
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'totals' },
      stat('Foods known', String(ctx.snap.foodCount), 'from files you supplied')),
    field('Source', foodSource),
    field('CSV file', foodFile),
    h('p', {
      class: 'hint',
      text: 'No food data ships with this app. Every value it shows came from a file you loaded, '
          + 'stored with the source it came from and the error band that source is good for — a '
          + 'label figure is ±22%, because that is what FSSAI actually permits.',
    })));

  // ---- garmin auto-sync ----
  wrap.append(h('h2', { text: 'Garmin auto-sync' }));
  const syncCard = h('div', { class: 'card' });
  const st = ctx.snap.syncStatus;

  if (ctx.snap.syncConfigured) {
    syncCard.append(h('ul', { class: 'list' },
      goalRow('Server', st ? `${st.adapter}${st.credentialsConfigured ? '' : ' — no Garmin credentials'}` : 'not reachable'),
      goalRow('Server last pulled Garmin', st?.lastSuccessAt ? st.lastSuccessAt.slice(0, 16).replace('T', ' ') : 'never'),
      goalRow('App last collected', ctx.snap.syncLastPulled
        ? ctx.snap.syncLastPulled.slice(0, 16).replace('T', ' ') : 'never'),
      st?.intervalMin ? goalRow('Automatic every', `${st.intervalMin} min`) : null as any,
    ));
  }

  if (ctx.snap.syncError) {
    // A sync that fails quietly is worse than none: you would carry on
    // believing the numbers were fresh.
    syncCard.append(h('div', { class: 'incomplete', text: `Sync problem: ${ctx.snap.syncError}` }));
  }
  if (st?.lastError) {
    syncCard.append(h('div', { class: 'incomplete', text:
      `The server's last Garmin pull failed: ${st.lastError}` }));
  }

  const tokenInput = h('input', {
    type: 'password', placeholder: ctx.snap.syncConfigured ? '•••••• (set)' : 'paste SYNC_TOKEN',
    autocomplete: 'off',
  });
  syncCard.append(field('Sync token', tokenInput));
  syncCard.append(h('div', { class: 'actions' },
    h('button', {
      class: 'btn quiet', text: 'Forget',
      onclick: () => void after(ctx, ctx.store.setSyncToken(null), 'Token cleared.'),
    }),
    h('button', {
      class: 'btn', text: 'Save token',
      onclick: () => {
        if (!tokenInput.value.trim()) { toast('Paste the token first.', { tone: 'warn' }); return; }
        void after(ctx, ctx.store.setSyncToken(tokenInput.value.trim()), 'Token saved.');
      },
    }),
    h('button', {
      class: 'btn primary', text: 'Sync now',
      onclick: async () => {
        if (!ctx.snap.syncConfigured) { toast('Set the sync token first.', { tone: 'warn' }); return; }
        try {
          const out = await ctx.store.syncNow();
          ctx.rerender();
          toast(out
            ? `Pulled ${out.activities} workouts and ${out.metricRows} daily values.`
            : 'Sync failed — see the message above.',
            { tone: out ? 'ok' : 'error' });
        } catch (e) { toast((e as Error).message, { tone: 'error' }); }
      },
    })));
  syncCard.append(h('p', { class: 'hint', text:
    'Auto-pull needs a server, because Garmin requires an OAuth secret and somewhere to push '
    + 'to, and a browser page can hold neither. The server runs on your own infrastructure, '
    + 'holds your Garmin credentials, and keeps only a rolling window — your history stays here, '
    + 'in this browser.' }));
  syncCard.append(h('p', { class: 'hint', text:
    'Everything it pulls goes through the same import the CSV path uses, so the same guarantees '
    + 'hold: re-pulling corrects rather than duplicates, Garmin\'s calorie figure stays its own '
    + 'estimate, and a missing metric stays missing rather than becoming zero.' }));
  wrap.append(syncCard);

  // ---- garmin file import ----
  wrap.append(h('h2', { text: 'Body data (Garmin file)' }));
  const garminFile = h('input', { type: 'file', accept: '.csv,text/csv' });
  garminFile.addEventListener('change', async () => {
    const f = garminFile.files?.[0];
    if (!f) return;
    try {
      const r = await ctx.store.importGarminCsv(await f.text());
      ctx.rerender();
      const bits = [];
      if (r.activitiesInserted) bits.push(`${r.activitiesInserted} workouts`);
      if (r.metricRows) bits.push(`${r.metricRows} daily values`);
      toast(bits.length ? `Imported ${bits.join(', ')}.` : 'Nothing new in that file.', {
        detail: r.skipped.length ? `${r.skipped.length} rows skipped` : undefined,
      });
    } catch (e) { toast((e as Error).message, { tone: 'error' }); }
  });

  const coverage = ctx.snap.sourceCoverage;
  const garminCard = h('div', { class: 'card' },
    field('Garmin CSV export (activities or wellness)', garminFile));

  if (coverage.length) {
    garminCard.append(h('ul', { class: 'list' }, ...coverage.map((c) => h('li', {},
      h('span', { class: 'grow' },
        h('div', { class: 'name', text: c.series.replace(/_/g, ' ') }),
        h('div', { class: 'sub mono', text: `${c.first_seen} to ${c.last_seen}` })),
      h('span', { class: 'pill', text: c.source }),
      h('span', { class: 'kcal', text: String(c.n) })))));
  }

  garminCard.append(h('p', {
    class: 'hint',
    text: 'Exported files, not an API. Connecting to Garmin directly needs an OAuth secret '
        + 'and a webhook endpoint, which would mean running a server that holds a token and '
        + 'sees your health data — a steep price for data that arrives once a day.',
  }));
  garminCard.append(h('p', {
    class: 'hint',
    text: 'Its calorie figure is stored as its own estimate and is never added to any other. '
        + 'The list above shows when each source starts: beginning a new one partway through '
        + 'a series is a step change in measurement, which is the one thing the model cannot '
        + 'cancel out — so it is a row you can see rather than a surprise in the residuals.',
  }));
  wrap.append(garminCard);

  // ---- history ----
  wrap.append(h('h2', { text: 'History' }));
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const report = await ctx.store.importHealthifyCsv(await f.text());
      ctx.rerender();
      toast(`Imported ${report.inserted} entries.`, {
        detail: report.droppedColumns.length
          ? `dropped ${report.droppedColumns.length} nutrient columns` : undefined,
      });
    } catch (e) { toast((e as Error).message, { tone: 'error' }); }
  });
  wrap.append(h('div', { class: 'card' },
    field('Healthify CSV export', file),
    h('p', {
      class: 'hint',
      text: 'Names, portions and timestamps only. Their calorie figures are dropped on import and '
          + 'there is no column to put them in: a different food database is a step change in '
          + 'bias, and that is the one thing the model cannot cancel out.',
    })));

  return wrap;
}


// ------------------------------------------------------------------
// GOAL
//
// Owner-authorised: the brief put goal setting out of scope for v0, and
// the owner has since put it in.
//
// Modelled on calculator.net's calorie calculator and on the goal screen
// the owner supplied, with one difference that matters: where those show
// a single number, this shows every formula that could run. They disagree
// by a couple of hundred kcal on the same body, and hiding that would
// claim a precision none of them has.
// ------------------------------------------------------------------
export function goalView(ctx: Ctx): HTMLElement {
  const p = ctx.snap.profile;
  const wrap = h('div', {});

  // ---- weight goal ----
  const w = ctx.snap.weight;
  if (w) {
    const rows: HTMLElement[] = [
      goalRow('Current weight', `${w.currentKg} kg`),
      goalRow('Start weight', `${w.startKg} kg`),
    ];
    if (w.goalKg !== null) rows.push(goalRow('Goal weight', `${w.goalKg} kg`));
    rows.push(goalRow(w.lostKg >= 0 ? 'Lost so far' : 'Gained so far',
      `${Math.abs(w.lostKg)} kg${w.remainingKg !== null ? ` of ${Math.abs(w.lostKg) + w.remainingKg} kg` : ''}`));
    if (w.weeksToGoal !== null) {
      rows.push(goalRow('At this rate', `${w.weeksToGoal} weeks to go`));
    }
    const card = h('div', { class: 'card' }, h('ul', { class: 'list' }, ...rows));
    if (w.rateContradictsGoal) {
      card.append(h('div', { class: 'incomplete', text:
        'Your goal weight lies the other side of your current weight from the rate you picked, '
        + 'so there is no arrival date to compute. The rate is used as set.' }));
    }
    wrap.append(h('h2', { text: 'Weight goal' }), card);
  }

  // ---- the form ----
  const sex = h('select', {},
    ...(['male', 'female'] as Sex[]).map((v) => h('option', {
      value: v, selected: p?.sex === v ? '' : null, text: v,
    })));
  const age = h('input', { type: 'number', min: '15', max: '80', step: '1', value: p?.ageYears ?? '' });
  const height = h('input', { type: 'number', min: '80', max: '250', step: '0.5', value: p?.heightCm ?? '' });
  const weight = h('input', { type: 'number', min: '25', max: '400', step: '0.1', value: p?.weightKg ?? '' });
  const goalWeight = h('input', {
    type: 'number', min: '25', max: '400', step: '0.1',
    value: p?.goalWeightKg ?? '', placeholder: 'optional',
  });
  const bodyFat = h('input', {
    type: 'number', min: '3', max: '70', step: '0.1',
    value: p?.bodyFatPct ?? '', placeholder: 'only if measured',
  });
  const activity = h('select', {}, ...ACTIVITY_LEVELS.map((a) => h('option', {
    value: String(a.factor),
    selected: p && Math.abs(p.activityFactor - a.factor) < 1e-9 ? '' : null,
    text: a.label,
  })));
  const goal = h('select', {}, ...GOAL_RATES.map((g) => h('option', {
    value: String(g.rate),
    selected: p && Math.abs(p.goalRateKgPerWeek - g.rate) < 1e-9 ? '' : null,
    text: g.label,
  })));

  const preview = h('div', {});

  const readForm = (): BodyProfile | null => {
    if ([age.value, height.value, weight.value].some((v) => v === '')) return null;
    return {
      sex: sex.value as Sex,
      ageYears: Number(age.value),
      heightCm: Number(height.value),
      weightKg: Number(weight.value),
      bodyFatPct: bodyFat.value === '' ? null : Number(bodyFat.value),
      activityFactor: Number(activity.value),
      goalRateKgPerWeek: Number(goal.value),
      goalWeightKg: goalWeight.value === '' ? null : Number(goalWeight.value),
    };
  };

  const renderPreview = () => {
    preview.replaceChildren();
    const form = readForm();
    if (!form) {
      preview.append(h('p', { class: 'hint', text: 'Fill in age, height and weight to see the estimates.' }));
      return;
    }
    const estimates = estimateTargets(form);
    preview.append(h('ul', { class: 'list' }, ...estimates.map((e) => h('li', {},
      h('span', { class: 'grow' },
        h('div', { class: 'name', text: e.source }),
        h('div', { class: 'sub mono', text: e.basis })),
      h('span', { class: 'pill', text: `${e.percentOfMaintenance}%` }),
      h('span', { class: 'kcal', text: fmt.kcal(e.target) })))));

    const chosen = estimates[0];
    if (chosen) {
      const note = safetyCheck(form, chosen.target);
      if (note.message) preview.append(h('div', { class: 'incomplete', text: note.message }));

      if (form.goalWeightKg !== null && form.goalWeightKg !== undefined) {
        const needed = rateForGoal(form.weightKg, form.goalWeightKg, 12);
        preview.append(h('p', { class: 'hint', text:
          `To reach ${form.goalWeightKg} kg in twelve weeks you would need `
          + `${needed} kg/week. You have picked ${form.goalRateKgPerWeek}.` }));
      }
    }
    if (!form.bodyFatPct) {
      preview.append(h('p', {
        class: 'hint',
        text: 'Katch-McArdle is skipped because it needs a measured body-fat figure. Guessing one '
            + 'to feed the single formula whose advantage is measured lean mass would be theatre.',
      }));
    }
  };

  for (const el of [sex, age, height, weight, goalWeight, bodyFat, activity, goal]) {
    el.addEventListener('input', renderPreview);
    el.addEventListener('change', renderPreview);
  }

  wrap.append(h('h2', { text: 'You' }));
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'row' }, field('Sex', sex), field('Age', age)),
    h('div', { class: 'row' }, field('Height (cm)', height), field('Weight (kg)', weight)),
    h('div', { class: 'row' }, field('Goal weight (kg)', goalWeight), field('Body fat %', bodyFat)),
    field('Activity', activity),
    field('Goal', goal),
    h('div', { class: 'actions' },
      h('button', {
        class: 'btn primary', text: p ? 'Update' : 'Set goal',
        onclick: () => {
          const form = readForm();
          if (!form) { toast('Age, height and weight are needed.', { tone: 'warn' }); return; }
          void after(ctx, ctx.store.saveProfile(form), 'Goal saved.');
        },
      }))));

  wrap.append(h('h2', { text: 'Estimates' }));
  const estCard = h('div', { class: 'card' }, preview);
  estCard.append(h('p', {
    class: 'hint',
    text: 'These are population regressions evaluated on one person. Mifflin-St Jeor predicts an '
        + 'individual to roughly ±10%, and the formulas routinely differ by a couple of hundred '
        + 'kcal on the same body — so each is kept separately and none is averaged with another. '
        + 'A starting line, not a measurement of you.',
  }));
  wrap.append(estCard);

  // ---- nutrition goal ----
  const m = ctx.snap.macros;
  if (m && ctx.snap.target) {
    const preset = MACRO_PRESETS.find((x) =>
      x.proteinPct === ctx.snap.settings.macro_protein_pct
      && x.carbPct === ctx.snap.settings.macro_carb_pct
      && x.fatPct === ctx.snap.settings.macro_fat_pct);

    const card = h('div', { class: 'card' },
      h('ul', { class: 'list' },
        goalRow('Daily calorie budget', `${fmt.kcal(ctx.snap.target.kcal)} Cal`),
        goalRow('Protein', `${m.proteinG} g`),
        goalRow('Carb', `${m.carbG} g`),
        goalRow('Fat', `${m.fatG} g`),
        goalRow('Fibre', `${m.fibreG} g`)));

    const split = h('select', {}, ...MACRO_PRESETS.map((x) => h('option', {
      value: x.key, selected: preset?.key === x.key ? '' : null, text: x.label,
    })));
    split.addEventListener('change', () => {
      const chosen = MACRO_PRESETS.find((x) => x.key === split.value)!;
      void after(ctx, Promise.all([
        ctx.store.setSetting('macro_protein_pct', chosen.proteinPct),
        ctx.store.setSetting('macro_carb_pct', chosen.carbPct),
        ctx.store.setSetting('macro_fat_pct', chosen.fatPct),
      ]), `Split set to ${chosen.label}.`);
    });
    card.append(field('Macronutrient split', split));

    if (m.splitSumsTo !== 100) {
      card.append(h('div', { class: 'incomplete', text:
        `Your split adds to ${m.splitSumsTo}%, not 100. The grams above use it exactly as set.` }));
    }
    card.append(h('p', { class: 'hint', text:
      'Fibre scales with intake at 14 g per 1000 kcal rather than being a flat number.' }));
    wrap.append(h('h2', { text: 'Nutrition goal' }), card);
  }

  // ---- calorie cycling ----
  wrap.append(h('h2', { text: 'Spread across the week' }));
  const cycleCard = h('div', { class: 'card' });
  if (ctx.snap.weekPlan.length) {
    cycleCard.append(h('ul', { class: 'list' }, ...ctx.snap.weekPlan.map((d) => h('li', {},
      h('span', { class: 'grow' },
        h('div', { class: 'name', text: d.logDate }),
        h('div', { class: 'sub mono', text: d.basis })),
      h('span', { class: 'kcal', text: fmt.kcal(d.kcal) })))));
    const total = ctx.snap.weekPlan.reduce((s, d) => s + d.kcal, 0);
    cycleCard.append(h('p', { class: 'hint mono', text: `week total ${fmt.kcal(total)} kcal` }));
  } else {
    cycleCard.append(h('div', { class: 'empty quiet', text: 'Not planned — every day gets the flat target.' }));
  }
  cycleCard.append(h('div', { class: 'actions' },
    h('button', {
      class: 'btn', text: 'Clear',
      onclick: () => void after(ctx, ctx.store.clearPlan(), 'Back to a flat week.'),
    }),
    h('button', {
      class: 'btn primary', text: 'Plan the week',
      onclick: () => {
        if (!ctx.snap.target) { toast('Set a goal first.', { tone: 'warn' }); return; }
        void after(ctx, ctx.store.planWeek(), 'Week planned.');
      },
    })));
  cycleCard.append(h('p', { class: 'hint', text:
    'The same weekly total, redistributed. Training days and days your watch says you recovered '
    + 'badly get more; well-rested days take the deeper deficit. The week always sums to what a '
    + 'flat week would have been, so this changes when the calories fall, never how many.' }));
  cycleCard.append(h('p', { class: 'hint', text:
    'A transparent weighted sum, not a black box — each day says which input moved it and by how '
    + 'much, so a suggestion you disagree with can be argued with. That training days need more '
    + 'fuel is uncontroversial; that HRV and sleep should shift intake is plausible and widely '
    + 'practised but not established, which is why the swing is capped and can be set to zero.' }));
  wrap.append(cycleCard);

  // ---- water and steps ----
  const waterGoal = ctx.snap.settings.water_goal_glasses;
  const water = ctx.snap.waterToday;
  const stepsGoal = ctx.snap.settings.steps_goal;
  const steps = ctx.snap.stepsToday;

  wrap.append(h('h2', { text: 'Other goals' }));
  wrap.append(h('div', { class: 'card' },
    h('ul', { class: 'list' },
      h('li', {},
        h('span', { class: 'grow' },
          h('div', { class: 'name', text: 'Water' }),
          h('div', { class: 'sub', text: `${water} of ${waterGoal} glasses` })),
        h('button', { class: 'btn', text: '−', onclick: () =>
          void after(ctx, ctx.store.logWater(Math.max(0, water - 1)), 'Water updated.') }),
        h('button', { class: 'add', text: '+', onclick: () =>
          void after(ctx, ctx.store.logWater(water + 1), 'Water updated.') })),
      h('li', {},
        h('span', { class: 'grow' },
          h('div', { class: 'name', text: 'Steps' }),
          h('div', { class: 'sub', text: steps === null
            ? `goal ${stepsGoal.toLocaleString()} — import Garmin to fill this in`
            : `${Math.round(steps).toLocaleString()} of ${stepsGoal.toLocaleString()}` })))),
    h('p', { class: 'hint', text:
      'Steps come from your watch; water is the one thing here you tell the app. Neither affects '
      + 'the intake total.' })));

  // ---- override ----
  const manual = h('input', {
    type: 'number', min: '500', max: '8000', step: '10',
    value: ctx.snap.target?.source === 'manual' ? ctx.snap.target.kcal : '',
    placeholder: 'e.g. 2200',
  });
  wrap.append(h('h2', { text: 'Override' }));
  wrap.append(h('div', { class: 'card' },
    field('Set the target by hand', manual),
    h('div', { class: 'actions' },
      h('button', {
        class: 'btn', text: 'Use formula',
        onclick: () => void after(ctx, ctx.store.setManualTarget(null), 'Back to the formula.'),
      }),
      h('button', {
        class: 'btn primary', text: 'Use this number',
        onclick: () => {
          if (manual.value === '') return;
          void after(ctx, ctx.store.setManualTarget(Number(manual.value)), 'Target set.');
        },
      })),
    h('p', { class: 'hint', text:
      'A number you set outranks every formula and the cycled plan, and the estimates are kept '
      + 'beside it rather than deleted. If it sits below the safe floor you are told once, and '
      + 'then it is used exactly as entered.' })));

  renderPreview();
  return wrap;
}

function goalRow(label: string, value: string): HTMLElement {
  return h('li', {},
    h('span', { class: 'grow' }, h('div', { class: 'name', text: label })),
    h('span', { class: 'kcal', text: value }));
}
