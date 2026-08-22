/**
 * The undo toast, which exists so there is no confirmation step.
 *
 * A confirm screen turns a two-second gesture into a five-second one and
 * it is the single most common reason food logging stops happening. The
 * entry is already committed by the time this appears; the toast just
 * offers a window in which to revoke it.
 */

let timer: number | undefined;

export interface ToastOptions {
  tone?: 'ok' | 'warn' | 'error';
  detail?: string;
  undo?: () => void;
  undoWindowMs?: number;
}

export function toast(message: string, opts: ToastOptions = {}): void {
  const el = document.getElementById('toast')!;
  el.replaceChildren();
  el.dataset.tone = opts.tone ?? 'ok';

  const text = document.createElement('span');
  text.className = 'grow';
  text.textContent = message;
  el.append(text);

  if (opts.detail) {
    const d = document.createElement('span');
    d.className = 'ms';
    d.textContent = opts.detail;
    el.append(d);
  }

  const window_ = opts.undoWindowMs ?? 5000;
  if (opts.undo) {
    const b = document.createElement('button');
    b.className = 'undo';
    b.textContent = 'Undo';
    b.onclick = () => { opts.undo!(); hide(); };
    el.append(b);
  }

  el.dataset.show = '1';
  clearTimeout(timer);
  timer = window.setTimeout(hide, opts.undo ? window_ : 2600);
}

function hide(): void {
  const el = document.getElementById('toast')!;
  el.dataset.show = '0';
}
