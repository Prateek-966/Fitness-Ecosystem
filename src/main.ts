import './styles.css';
import { Store } from './app/store';
import { Mic, speechSupported } from './app/speech';
import { h, clear, fmt } from './app/dom';
import { toast } from './app/toast';
import { absNow } from './core/clock';
import { calibrateView, diagnosticsView, pendingView, todayView } from './app/views';

type Tab = 'today' | 'pending' | 'measures' | 'diagnostics';

const root = document.getElementById('app')!;
const mic = new Mic();
let store: Store;
let tab: Tab = 'today';

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
  const ctx = { store, snap, rerender: render };
  clear(root);

  root.append(
    h('header', { class: 'top' },
      h('h1', { text: 'Log' }),
      h('span', {
        class: 'date',
        text: new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
      })),
    tabs(snap.pending.length + snap.orphans.length),
  );

  if (tab === 'today') root.append(micPanel(), todayView(ctx));
  else if (tab === 'pending') root.append(pendingView(ctx));
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

  const typed = h('input', { type: 'text', placeholder: 'or type it — "two rotis, one katori dal"' });
  typed.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Enter' || !typed.value.trim()) return;
    const now = absNow();
    const text = typed.value.trim();
    typed.value = '';
    void commit(text, now, now, null);
  });

  return h('div', {},
    h('div', { class: 'mic-wrap' }, button, heard),
    h('div', { class: 'card' }, typed));
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
    out = await store.log(transcript, { micTap, sttReturned, confidence });
  } catch (e) {
    toast((e as Error).message, { tone: 'error' });
    return;
  }
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
