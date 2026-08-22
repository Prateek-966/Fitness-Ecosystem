import { h, clear } from './dom';

/** Bottom sheet. One at a time, dismissable by backdrop or Escape. */
export function sheet(
  title: string, subtitle: string | null, body: HTMLElement, actions: HTMLElement[],
): () => void {
  const panel = h('div', { class: 'sheet' },
    h('h3', { text: title }),
    subtitle ? h('div', { class: 'sub', text: subtitle }) : null,
    body,
    h('div', { class: 'actions' }, ...actions),
  );
  const bg = h('div', { class: 'sheet-bg' }, panel);

  const close = () => {
    bg.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };

  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(bg);
  return close;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, h('label', { text: label }), control);
}

export { clear };
