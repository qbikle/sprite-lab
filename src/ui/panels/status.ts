/** Bottom bar: cursor position, doc size, zoom, transient status messages.
 *  Listens: cursor:moved, camera:changed, status:message, doc:replaced. */
import type { Bus } from '../../core/bus';

export interface StatusBarOpts {
  host: HTMLElement;
  bus: Bus;
  getZoom(): number;
  getDocSize(): { w: number; h: number };
  /** Wave 9 (additive): size cell click → resize dialog. Absent = plain cell. */
  onSizeClick?(): void;
}

const EM_DASH = '—';
const TIMES = '×';

export class StatusBar {
  private readonly opts: StatusBarOpts;
  private readonly unsubs: Array<() => void> = [];
  private cursorEl: HTMLElement | null = null;
  private msgEl: HTMLElement | null = null;
  private sizeEl: HTMLElement | null = null;
  private zoomEl: HTMLElement | null = null;
  private msgTimer: number | null = null;

  constructor(opts: StatusBarOpts) {
    this.opts = opts;
  }

  mount(): void {
    const o = this.opts;

    const cursor = document.createElement('div');
    cursor.className = 'sl-status-cursor';
    cursor.textContent = EM_DASH;
    const msg = document.createElement('div');
    msg.className = 'sl-status-msg';
    const doc = document.createElement('div');
    doc.className = 'sl-status-doc';
    const size = document.createElement('span');
    size.className = 'sl-status-size';
    if (o.onSizeClick) {
      const onSizeClick = o.onSizeClick.bind(o);
      size.classList.add('sl-status-size-btn');
      size.setAttribute('role', 'button');
      size.tabIndex = 0;
      size.title = 'resize canvas';
      size.addEventListener('click', onSizeClick);
      size.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        // keep play/pause + space-pan shortcuts out of the focused cell
        e.preventDefault();
        e.stopPropagation();
        onSizeClick();
      });
    }
    const zoom = document.createElement('span');
    zoom.className = 'sl-status-zoom';
    doc.append(size, zoom);
    o.host.append(cursor, msg, doc);

    this.cursorEl = cursor;
    this.msgEl = msg;
    this.sizeEl = size;
    this.zoomEl = zoom;

    this.unsubs.push(
      o.bus.on('cursor:moved', ({ p }) => {
        if (this.cursorEl) this.cursorEl.textContent = p ? `${p.x},${p.y}` : EM_DASH;
      }),
      o.bus.on('status:message', ({ text }) => this.showMessage(text)),
      o.bus.on('camera:changed', () => this.syncDoc()),
      o.bus.on('doc:replaced', () => this.syncDoc()),
    );
    this.syncDoc();
  }

  unmount(): void {
    if (this.msgTimer !== null) {
      window.clearTimeout(this.msgTimer);
      this.msgTimer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.opts.host.replaceChildren();
    this.cursorEl = this.msgEl = this.sizeEl = this.zoomEl = null;
  }

  private showMessage(text: string): void {
    if (!this.msgEl) return;
    this.msgEl.textContent = text;
    this.msgEl.classList.add('sl-live');
    if (this.msgTimer !== null) window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => {
      this.msgEl?.classList.remove('sl-live');
      this.msgTimer = null;
    }, 2500);
  }

  private syncDoc(): void {
    const { w, h } = this.opts.getDocSize();
    if (this.sizeEl) this.sizeEl.textContent = `${w}${TIMES}${h}`;
    if (this.zoomEl) this.zoomEl.textContent = `${Math.round(this.opts.getZoom() * 100)}%`;
  }
}
