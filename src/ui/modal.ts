/* Shared modal primitive — Wave 9.
   API is frozen for this wave (consumers: newdoc panel, cheat sheet, themed
   confirm). Hardened: real focus trap (Tab/Shift+Tab cycle inside the card),
   capture-phase key swallowing (ALL non-typing keydowns — single keys AND app
   shortcut combos — stop here while open; see gotcha ledger), body scroll
   lock, transition-friendly mount. Backdrop click closes, Esc closes, focus
   returns to the opener. */

export interface ModalOpts {
  /** aria-label for the dialog. */
  label: string;
  /** Extra class on the card, e.g. 'sl-newdoc'. */
  className?: string;
  /** Fired on every close path (backdrop, Esc, close()). */
  onClose?: () => void;
}

/* Open-modal stack: every open modal has a capture listener on window, and
   stopPropagation does NOT silence same-node listeners — so each handler
   defers to the stack and only the TOP modal reacts. One Esc closes one
   modal, not the whole pile. */
const modalStack: Modal[] = [];

/** Closes every open modal, top-first — app teardown's safety net so an
 *  unmount never strands a dialog, its key-capture listener, or the body
 *  scroll lock. */
export function closeAllModals(): void {
  for (const m of [...modalStack].reverse()) m.close();
}

/* Body scroll lock is refcounted so stacked modals (confirm over newdoc)
   restore the original overflow only when the last one closes. */
let scrollLocks = 0;
let savedOverflow = '';

function lockScroll(): void {
  if (scrollLocks === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLocks += 1;
}

function unlockScroll(): void {
  if (scrollLocks === 0) return;
  scrollLocks -= 1;
  if (scrollLocks === 0) document.body.style.overflow = savedOverflow;
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), ' +
  'select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export class Modal {
  readonly root: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly opts: ModalOpts;
  private opener: HTMLElement | null = null;
  private disposed = false;
  private openState = false;

  /** Capture-phase guard: Esc closes, Tab is trapped, typing inside the card
   *  passes through, and EVERYTHING else stops here — global single-key
   *  shortcuts and mod-combos must never fire behind a dialog. Default
   *  actions (Enter/Space activating a focused button) are untouched:
   *  stopPropagation, never preventDefault. */
  private readonly onKeyCapture = (e: KeyboardEvent): void => {
    if (!this.openState) return;
    if (modalStack[modalStack.length - 1] !== this) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === 'Tab') {
      e.stopPropagation();
      this.trapTab(e);
      return;
    }
    const t = e.target;
    const typing =
      t instanceof HTMLElement &&
      this.root.contains(t) &&
      (t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement ||
        t.isContentEditable);
    if (!typing) e.stopPropagation();
  };

  constructor(opts: ModalOpts) {
    this.opts = opts;
    this.overlay = document.createElement('div');
    this.overlay.className = 'sl-modal-overlay';
    this.root = document.createElement('div');
    this.root.className = `sl-modal-card${opts.className ? ` ${opts.className}` : ''}`;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', opts.label);
    this.root.tabIndex = -1;
    this.overlay.append(this.root);
    this.overlay.addEventListener('pointerdown', (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  open(): void {
    if (this.openState || this.disposed) return;
    this.openState = true;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    modalStack.push(this);
    document.body.append(this.overlay);
    lockScroll();
    window.addEventListener('keydown', this.onKeyCapture, true);
    // transition-friendly: flush the mounted (hidden) styles, then arm .sl-open
    this.overlay.getBoundingClientRect();
    this.overlay.classList.add('sl-open');
    this.root.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    const i = modalStack.indexOf(this);
    if (i !== -1) modalStack.splice(i, 1);
    window.removeEventListener('keydown', this.onKeyCapture, true);
    this.overlay.classList.remove('sl-open');
    this.overlay.remove();
    unlockScroll();
    if (this.opener !== null && document.contains(this.opener)) {
      this.opener.focus({ preventScroll: true });
    }
    this.opener = null;
    this.opts.onClose?.();
  }

  dispose(): void {
    this.close();
    this.disposed = true;
  }

  /** Visible, enabled focus candidates inside the card, in DOM order. */
  private focusables(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const el of this.root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
      if (el.getClientRects().length > 0) out.push(el);
    }
    return out;
  }

  private trapTab(e: KeyboardEvent): void {
    const els = this.focusables();
    const first = els[0];
    const last = els[els.length - 1];
    if (first === undefined || last === undefined) {
      e.preventDefault();
      this.root.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && this.root.contains(active);
    if (!inside || active === this.root) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
    // interior elements: default Tab stays inside — first/last are handled
  }
}

export interface ConfirmOpts {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

export function confirmModal(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const modal = new Modal({
      label: opts.title,
      className: 'sl-confirm',
      onClose: () => settle(false),
    });
    const title = document.createElement('h2');
    title.className = 'sl-modal-title';
    title.textContent = opts.title;
    const body = document.createElement('p');
    body.className = 'sl-modal-body';
    body.textContent = opts.body;
    const row = document.createElement('div');
    row.className = 'sl-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'sl-modal-cancel';
    cancel.textContent = opts.cancelLabel ?? 'cancel';
    cancel.addEventListener('click', () => modal.close());
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = opts.danger ? 'sl-modal-danger' : 'sl-modal-primary';
    ok.textContent = opts.confirmLabel ?? 'ok';
    ok.addEventListener('click', () => {
      settle(true);
      modal.close();
    });
    row.append(cancel, ok);
    modal.root.append(title, body, row);
    modal.open();
    ok.focus();
  });
}

/* DEV-only harness: lets e2e drive a confirm dialog without a wired consumer.
   Stripped from prod builds. */
if (import.meta.env.DEV) {
  (window as unknown as { __labModal?: object }).__labModal = { confirmModal };
}
