import './styles.css';
import { Store } from './app/store';
import { Mic, speechSupported } from './app/speech';
import { h, clear, fmt } from './app/dom';
import { toast } from './app/toast';
import { absNow } from './core/clock';
import { parse } from './core/parse';
import { calibrateView, diagnosticsView, goalView, pendingView, todayView } from './app/views';

type Tab = 'today' | 'pending' | 'goal' | 'measures' | 'diagnostics';

const root = document.getElementById('app')!;
const mic = new Mic();
let store: Store;
let tab: Tab = 'today';
/** Set by a meal section's + button; cleared after the next capture. */
let pendingSlot: string | null = null;

void boot();

async function boot(): Promise<void> {
  root.append(h('div', { class: 'empty', text: 'Opening your log…' }));
  try {
    store = await Store.open();
  } catch (e) {
    clear(root);
    root.append(h('div', { class: 'card' },
      h('div', { class: 'name', text: 'Could not open the database.' }),
      h('p', { class: 'hint', text: String(e) })));
    return;
  }
  render();
}

function render(): void {
  const snap = store.snapshot;
  const ctx = {
    store, snap, rerender: render,
    /** Move to another tab. Only the first-run notice uses this. */
    go: (to: string) => { tab = to as Tab; render(); },
    onAddTo: (slot: string | null) => {
      pendingSlot = slot;
      render();
      document.querySelector<HTMLElement>('.mic-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      document.querySelector<HTMLInputElement>('.capture input[type=text]')?.focus();
    },
  };
  clear(root);

  root.append(
    h('header', { class: 'top' },
      h('h1', { text: 'Log' }),
      h('span', {
        class: 'date',
        text: new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
      })),
    tabs(snap.pending.length + snap.orphanItems.length),
  );

  if (tab === 'today') root.append(micPanel(), todayView(ctx));
  else if (tab === 'pending') root.append(pendingView(ctx));
  else if (tab === 'goal') root.append(goalView(ctx));
  else if (tab === 'measures') root.append(calibrateView(ctx));
  else root.append(diagnosticsView(ctx));
}

function tabs(pendingCount: number): HTMLElement {
  const mk = (id: Tab, label: string, badge = 0) =>
    h('button', {
      'aria-current': tab === id ? 'page' : null,
      onclick: () => { tab = id; render(); },
    }, label, badge ? h('span', { class: 'badge', text: String(badge) }) : null);

  return h('nav', { class: 'tabs' },
    mk('today', 'Today'),
    mk('pending', 'Queue', pendingCount),
    mk('goal', 'Goal'),
    mk('measures', 'Measures'),
    mk('diagnostics', 'Diagnostics'));
}

// ------------------------------------------------------------------
// The mic. Timed from the tap, because that is what criterion 1 is about
// — not from the point where this code happens to take over.
// ------------------------------------------------------------------
function micPanel(): HTMLElement {
  const heard = h('div', { class: 'heard' });
  const button = h('button', { class: 'mic', dataset: { state: 'idle' }, text: 'Tap to log' });

  if (!speechSupported()) {
    button.disabled = true;
    button.textContent = 'No speech';
    heard.textContent = 'This browser has no Web Speech API. Type the entry instead.';
  }

  const idle = () => { button.dataset.state = 'idle'; button.textContent = 'Tap to log'; };

  button.onclick = () => {
    if (mic.listening) { mic.stop(); return; }

    const micTap = absNow();
    button.dataset.state = 'listening';
    button.textContent = 'Listening';
    heard.textContent = '';

    const started = mic.start({
      onInterim: (t) => { heard.textContent = t; },
      onError: (m) => { idle(); toast(m, { tone: 'error' }); },
      onEnd: () => { if (button.dataset.state === 'listening') idle(); },
      onResult: (r) => {
        button.dataset.state = 'working';
        button.textContent = 'Saving';
        void commit(r.transcript, micTap, performance.timeOrigin + r.at, r.confidence).finally(idle);
      },
    });
    if (!started) idle();
  };

  const typed = h('input', {
    type: 'text',
    placeholder: 'or type it — "two rotis, one katori dal"',
    autocomplete: 'off',
    role: 'combobox',
    'aria-expanded': 'false',
  });
  const suggestions = h('ul', { class: 'suggest', role: 'listbox' });
  const picker = foodPicker(typed, suggestions);

  typed.addEventListener('keydown', (e) => {
    const key = (e as KeyboardEvent).key;
    // The list gets first refusal on the navigation keys, so Enter
    // takes a highlighted suggestion rather than logging past it.
    if (picker.handleKey(key, e as KeyboardEvent)) return;
    if (key !== 'Enter' || !typed.value.trim()) return;
    const now = absNow();
    const text = typed.value.trim();
    typed.value = '';
    picker.close();
    void commit(text, now, now, null);
  });

  const capture = h('div', { class: 'card capture' },
    h('div', { class: 'combo' }, typed, suggestions));
  if (pendingSlot) {
    capture.prepend(h('div', { class: 'slot-target' },
      h('span', { text: `logging to ${pendingSlot}` }),
      h('button', {
        class: 'btn quiet', text: 'clear',
        onclick: () => { pendingSlot = null; render(); },
      })));
  }

  return h('div', {}, h('div', { class: 'mic-wrap' }, button, heard), capture);
}

/**
 * The food picker.
 *
 * What it is FOR: the app knows a food or it does not, and typing
 * "paneer bhurji" into a database that calls it something else fails
 * silently into the slow-path queue. Showing what is actually in there,
 * as you type, turns a later correction into an immediate choice.
 *
 * It searches on the food phrase the REAL PARSER extracts, not on the
 * raw string - "two rotis" has to search for "roti", and parse.ts
 * already knows how to strip a quantity and singularise a word. A second
 * implementation of that here would drift from the first one and the two
 * would disagree about what the user typed.
 *
 * Selecting a row rewrites only the food phrase and leaves the quantity
 * alone, so "two rot" becomes "two Roti wheat" rather than losing the
 * two. Nothing is logged by selecting; the entry still goes through the
 * same Enter, the same parser and the same commit path as before, which
 * is the point - this is an aid to typing, not a second way in.
 */
function foodPicker(input: HTMLInputElement, list: HTMLElement) {
  let hits: Array<{ id: number; name: string; kcal: number | null }> = [];
  let active = -1;
  let token = 0;

  const close = () => {
    hits = [];
    active = -1;
    clear(list);
    list.dataset.open = '0';
    input.setAttribute('aria-expanded', 'false');
  };

  const draw = () => {
    clear(list);
    if (hits.length === 0) { close(); return; }
    list.dataset.open = '1';
    input.setAttribute('aria-expanded', 'true');
    hits.forEach((f, i) => {
      list.append(h('li', {
        role: 'option',
        'aria-selected': i === active ? 'true' : 'false',
        // mousedown, not click: the input blurs before a click lands and
        // the blur handler would have closed the list underneath it.
        onmousedown: (e: Event) => { e.preventDefault(); choose(i); },
      },
      h('span', { class: 'suggest-name', text: f.name }),
      h('span', { class: 'suggest-kcal',
        text: f.kcal === null ? '' : `${Math.round(f.kcal)} per 100 g` })));
    });
  };

  /**
   * Replace the food words, keep the quantity.
   *
   * rawPhrase is the WHOLE item including its quantity and unit - "two
   * rot" for phrase "rot" - so swapping rawPhrase for the food name
   * silently eats the two. The food words are the last N words of
   * rawPhrase, where N is the word count of the normalised phrase:
   * singularising changes "rotis" to "roti" but never changes how many
   * words there are.
   */
  const choose = (i: number) => {
    const f = hits[i];
    if (!f) return;
    const items = parse(input.value);
    const last = items[items.length - 1];
    const raw = last?.rawPhrase ?? '';
    const at = raw ? input.value.toLowerCase().lastIndexOf(raw.toLowerCase()) : -1;

    if (at >= 0) {
      const words = raw.split(/\s+/);
      const foodWordCount = (last!.phrase.trim().split(/\s+/).length) || 1;
      const keep = words.slice(0, Math.max(0, words.length - foodWordCount)).join(' ');
      const replacement = keep ? `${keep} ${f.name}` : f.name;
      input.value = input.value.slice(0, at) + replacement + input.value.slice(at + raw.length);
    } else {
      input.value = f.name;
    }
    close();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };

  const search = async () => {
    const items = parse(input.value);
    // The phrase being typed is the last one, and a bare "rot" the
    // parser cannot place still deserves a lookup.
    const q = (items[items.length - 1]?.phrase
      ?? input.value.trim().split(/[\s,]+/).pop() ?? '').trim();
    if (q.length < 2) { close(); return; }

    const mine = ++token;
    const found = await store.searchFoods(q);
    // A slower earlier query must not overwrite a newer one's results.
    if (mine !== token) return;
    hits = found.slice(0, 8);
    active = -1;
    draw();
  };

  let debounce: number | undefined;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    // Short enough to feel immediate, long enough that a fast typist
    // does not run a query per keystroke.
    debounce = window.setTimeout(() => void search(), 120);
  });
  input.addEventListener('blur', () => window.setTimeout(close, 120));

  return {
    close,
    handleKey(key: string, e: KeyboardEvent): boolean {
      if (list.dataset.open !== '1') return false;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        active = key === 'ArrowDown'
          ? Math.min(active + 1, hits.length - 1)
          : Math.max(active - 1, -1);
        draw();
        return true;
      }
      if (key === 'Escape') { e.preventDefault(); close(); return true; }
      if (key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); return true; }
      return false;
    },
  };
}

/**
 * Commit, then report. There is no confirmation step: the entry is already
 * in the database by the time the toast appears, and the toast's only job
 * is to offer a window in which to take it back.
 */
async function commit(
  transcript: string, micTap: number, sttReturned: number, confidence: number | null,
): Promise<void> {
  let out: Awaited<ReturnType<Store['log']>>;
  try {
    out = await store.log(transcript, { micTap, sttReturned, confidence, mealSlot: pendingSlot });
  } catch (e) {
    toast((e as Error).message, { tone: 'error' });
    return;
  }
  pendingSlot = null;
  render();

  const logged = out.items.filter((i) => i.action === 'logged');
  const slow = out.items.filter((i) => i.action === 'slow_path');
  const needsAmount = logged.filter((i) => i.needsUser);
  const undoWindowMs = store.snapshot.settings.undo_window_ms;
  const undo = () => { void store.undo(out.utteranceId).then(render); };

  if (logged.length === 0) {
    // Nothing was written, and nothing was guessed. The utterance is safe
    // in the queue — say that plainly rather than showing an error.
    toast(slow.length ? 'Not recognised — saved to the queue.' : 'Nothing to log there.', {
      tone: 'warn', detail: fmt.ms(out.totalMs), undo, undoWindowMs,
    });
    return;
  }

  const parts = [`Logged ${logged.map((i) => i.phrase).join(', ')}`];
  if (needsAmount.length) parts.push(`(${needsAmount.length} needs an amount)`);
  if (slow.length) parts.push(`· ${slow.length} queued`);

  toast(parts.join(' '), {
    tone: needsAmount.length || slow.length ? 'warn' : 'ok',
    detail: fmt.ms(out.totalMs),
    undo: () => { undo(); toast('Undone.'); },
    undoWindowMs,
  });
}

// Recompute the nightly stats when the app returns to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store) void store.refresh().then(render);
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* offline is a bonus, not a requirement */ });
}
