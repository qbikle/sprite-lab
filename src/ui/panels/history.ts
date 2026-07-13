/** Right rail: command history list — click an entry to jump there (undo/redo runs). */
import type { Bus } from '../../core/bus';

export interface HistoryPanelOpts {
  host: HTMLElement;
  bus: Bus;
  entries(): { labels: readonly string[]; cursor: number };
  jumpTo(index: number): void; // 0 = pristine doc, entries.length = latest
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export class HistoryPanel {
  private readonly opts: HistoryPanelOpts;
  private readonly unsubs: Array<() => void> = [];
  private rootEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  constructor(opts: HistoryPanelOpts) {
    this.opts = opts;
  }

  mount(): void {
    const root = div('sl-history');
    const head = div('sl-panel-head');
    head.textContent = 'history';
    const list = div('sl-history-list');
    root.append(head, list);
    this.opts.host.appendChild(root);
    this.rootEl = root;
    this.listEl = list;

    this.unsubs.push(
      this.opts.bus.on('history:changed', () => this.refresh()),
      this.opts.bus.on('doc:replaced', () => this.refresh()),
    );
    this.refresh();
  }

  unmount(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.rootEl?.remove();
    this.rootEl = null;
    this.listEl = null;
  }

  private refresh(): void {
    const list = this.listEl;
    if (!list) return;
    const { labels, cursor } = this.opts.entries();
    list.replaceChildren();

    const rows: HTMLButtonElement[] = [];
    const addRow = (label: string, index: number): void => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sl-history-row';
      if (index === cursor) btn.classList.add('current');
      if (index > cursor) btn.classList.add('redo');
      btn.textContent = label;
      btn.title = label;
      btn.addEventListener('click', () => this.opts.jumpTo(index));
      list.appendChild(btn);
      rows.push(btn);
    };
    addRow('open', 0);
    labels.forEach((label, i) => addRow(label, i + 1));

    const cur = rows[cursor];
    if (!cur) return;
    if (cur.offsetTop < list.scrollTop) {
      list.scrollTop = cur.offsetTop;
    } else if (cur.offsetTop + cur.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = cur.offsetTop + cur.offsetHeight - list.clientHeight;
    }
  }
}
