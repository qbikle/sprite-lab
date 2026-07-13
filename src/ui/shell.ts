/** App layout: topbar / left toolbar / center canvas / right side panel / statusbar.
 *  Builds DOM + owns app.css; hands slots to panels. */
import './app.css';

export interface ShellSlots {
  topbar: HTMLElement;
  toolbar: HTMLElement;  // left rail
  canvas: HTMLElement;   // center, viewport mounts here
  side: HTMLElement;     // right rail (color panel now, more later)
  timeline: HTMLElement; // bottom strip above the statusbar (frames + playback)
  status: HTMLElement;   // bottom bar
}

function region(tag: 'header' | 'div', className: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

export class Shell {
  private root: HTMLElement | null = null;

  mount(root: HTMLElement): ShellSlots {
    this.root = root;
    root.classList.add('sl-shell');

    const topbar = region('header', 'sl-topbar');
    const wordmark = region('div', 'sl-wordmark');
    const px = document.createElement('span');
    px.className = 'sl-wordmark-px';
    px.setAttribute('aria-hidden', 'true');
    const lab = document.createElement('b');
    lab.textContent = 'lab';
    wordmark.append(px, 'sprite ', lab);
    const actions = region('div', 'sl-topbar-actions');
    topbar.append(wordmark, actions);

    const toolbar = region('div', 'sl-toolbar');
    const canvas = region('div', 'sl-canvas');
    const side = region('div', 'sl-side');
    const timeline = region('div', 'sl-timeline');
    const status = region('div', 'sl-status');
    root.replaceChildren(topbar, toolbar, canvas, side, timeline, status);

    return { topbar, toolbar, canvas, side, timeline, status };
  }

  unmount(): void {
    if (!this.root) return;
    this.root.replaceChildren();
    this.root.classList.remove('sl-shell');
    this.root = null;
  }
}
