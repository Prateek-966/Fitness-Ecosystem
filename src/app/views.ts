import type { Store } from './store';
import type { Snapshot } from './protocol';
import { h, fmt } from './dom';
import { field, sheet } from './sheet';
import { toast } from './toast';
import { normalise, parse } from '../core/parse';

/** Views draw from one snapshot; mutations go to the worker and hand back a new one. */
export type Rerender = () => void;
type Ctx = { store: Store; snap: Snapshot; rerender: Rerender };

const after = (ctx: Ctx, p: Promise<unknown>, msg: string) =>
  p.then(() => { ctx.rerender(); toast(msg); })
   .catch((e: Error) => toast(e.message, { tone: 'error' }));

// ------------------------------------------------------------------
// TODAY
// ------------------------------------------------------------------
export function todayView(ctx: Ctx): HTMLElement {
  const { totals, entries } = ctx.snap;
  const find = (n: string) => totals.nutrients.find((x) => x.nutrient === n);
  const kcal = find('kcal');

  const card = h('div', { class: 'card' },
    h('div', { class: 'totals' },
      stat('Intake index', kcal ? fmt.kcal(kcal.total) : '—',
           kcal ? `± ${fmt.kcal(kcal.absError)}` : 'nothing logged yet'),
      ...(['protein_g', 'carb_g', 'fat_g'] as const)
        .map(find)
        .filter((m): m is NonNullable<typeof m> => Boolean(m))
        .map((m) => stat(m.nutrient.replace('_g', ''), `${Math.round(m.total)} g`,
                         `± ${Math.round(m.absError)} g`))));

  if (!totals.complete) {
    // A day with pending entries is under-logged by a known amount. Say so
    // rather than showing a number that looks complete.
    card.append(h('div', { class: 'incomplete' },
      `${totals.pendingCount} ${totals.pendingCount === 1 ? 'entry is' : 'entries are'} missing `
      + 'an amount, so this total is low and today is excluded from the model. '
      + 'Clear the queue to close it.'));
  }

  return h('div', {}, card,
    h('h2', { text: 'Today' }),
    h('div', { class: 'card' },
      entries.length
        ? h('ul', { class: 'list' }, ...entries.map((e) => entryRow(ctx, e)))
        : h('div', { class: 'empty', text: 'Nothing logged yet today. Tap the mic.' })));
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

  // ---- garmin ----
  wrap.append(h('h2', { text: 'Body data (Garmin)' }));
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
