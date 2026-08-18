/** Lospec palette import dialog — one URL/slug input on the shared Modal
 *  primitive. Validate/shake on garbage, fetch on Enter or the button,
 *  quiet status line while fetching, typed failure messages inline.
 *  A leaf dialog like ui/modal's confirm: no editor state, no bus. */
import type { Rgba } from '../../core/contracts';
import { fetchLospecPalette, isLospecError, lospecSlug } from '../../io/palettes';
import { Modal } from '../modal';

function shake(el: HTMLElement): void {
  el.classList.remove('sl-shake');
  void el.offsetWidth;
  el.classList.add('sl-shake');
}

export function openLospecModal(opts: {
  onLoad: (palette: { name: string; colors: Rgba[] }) => void;
  /** Fired when the dialog closes without a successful load. */
  onCancel?: () => void;
}): void {
  let loaded = false;
  const modal = new Modal({
    label: 'lospec palette',
    className: 'sl-lospec',
    onClose: () => {
      if (!loaded) opts.onCancel?.();
    },
  });

  const title = document.createElement('h2');
  title.className = 'sl-modal-title';
  title.textContent = 'lospec palette';

  const hint = document.createElement('p');
  hint.className = 'sl-lospec-hint';
  hint.textContent = 'paste a lospec palette URL, or just its slug';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sl-lospec-input';
  input.placeholder = 'lospec.com/palette-list/sweetie-16';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'lospec palette URL or slug');
  input.addEventListener('animationend', () => input.classList.remove('sl-shake'));

  const status = document.createElement('p');
  status.className = 'sl-lospec-status';
  status.setAttribute('role', 'status');

  const actions = document.createElement('div');
  actions.className = 'sl-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sl-lospec-cancel';
  cancel.textContent = 'cancel';
  cancel.addEventListener('click', () => modal.close());
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'sl-modal-primary sl-lospec-fetch';
  go.textContent = 'fetch';
  actions.append(cancel, go);

  let busy = false;
  const submit = (): void => {
    if (busy) return;
    const slug = lospecSlug(input.value);
    if (slug === null) {
      status.textContent = '';
      status.classList.remove('error');
      shake(input);
      input.focus();
      return;
    }
    busy = true;
    input.disabled = true;
    go.disabled = true;
    status.classList.remove('error');
    status.textContent = `fetching ${slug}…`;
    void fetchLospecPalette(slug)
      .then((palette) => {
        if (!modal.isOpen) return; // Escaped mid-fetch — drop the result
        loaded = true;
        modal.close();
        opts.onLoad(palette);
      })
      .catch((err: unknown) => {
        if (!modal.isOpen) return;
        busy = false;
        input.disabled = false;
        go.disabled = false;
        status.classList.add('error');
        status.textContent = isLospecError(err)
          ? err.message
          : 'lospec said no — download the .gpl instead';
        shake(input);
        input.focus();
      });
  };
  go.addEventListener('click', submit);

  /* Enter routing (the newdoc idiom): the input submits, buttons keep their
   * native activation, nothing leaks to the global shortcut map. */
  modal.root.addEventListener('keydown', (e) => {
    const onButton = e.target instanceof HTMLButtonElement;
    if (e.key === 'Enter') {
      e.stopPropagation();
      if (onButton) return;
      e.preventDefault();
      submit();
    } else if (e.key === ' ' && onButton) {
      e.stopPropagation();
    }
  });

  modal.root.append(title, hint, input, status, actions);
  modal.open();
  input.focus();
}
