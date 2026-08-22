/** Minimal DOM helpers. No framework — the UI is a button and a list. */

type Attrs = Record<string, any>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element): void { el.replaceChildren(); }

export const fmt = {
  /** Rounded to the precision the underlying value actually has. */
  kcal: (n: number) => Math.round(n).toLocaleString(),
  grams: (n: number | null) => (n === null ? '—' : `${Math.round(n)} g`),
  time: (iso: string) => iso.slice(11, 16),
  pct: (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`),
  ms: (n: number | null) => (n === null ? '—' : `${Math.round(n)} ms`),
  qty: (q: number | null, unit: string | null) =>
    q === null ? 'no amount yet' : `${trimNum(q)}${unit ? ` ${unit}` : ''}`,
};

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}
