/** First-run warmth: boot status one-liners + a small dismissible corner card.
 *  The card floats bottom-right above the statusbar and never blocks the
 *  canvas; explicit dismiss only. */

const LINES: readonly string[] = [
  'hey. pixels won\'t place themselves.',
  'back again? the canvas missed you.',
  'mochi was here first.',
  'warm up those pixels.',
  'the undo button believes in you.',
  'tiny canvas, big plans.',
  'one pixel at a time, friend.',
  'draw something. mochi is watching.',
  'another day, another sprite.',
  'ready when you are. (=^..^=)',
];

/** A random warm one-liner for the boot status message. */
export function welcomeLine(): string {
  const i = Math.floor(Math.random() * LINES.length);
  return LINES[i] ?? 'hello, pixels.';
}

/** Mount the first-run corner card. Idempotent: a stray earlier card is
 *  replaced, never duplicated. Removes itself on dismiss, then calls
 *  onDismiss (the app's chance to persist "seen"). */
export function mountFirstRunCard(onDismiss: () => void): () => void {
  document.querySelector('.sl-welcome')?.remove();

  const card = document.createElement('aside');
  card.className = 'sl-welcome';
  card.setAttribute('aria-label', 'welcome');

  const head = document.createElement('div');
  head.className = 'sl-welcome-head';
  const title = document.createElement('span');
  title.className = 'sl-welcome-title';
  title.textContent = 'welcome to sprite lab';
  head.append(title);

  const body = document.createElement('p');
  body.className = 'sl-welcome-body';
  const kbd = document.createElement('kbd');
  kbd.textContent = '?';
  body.append(
    'the little cat is mochi, your demo sprite — draw right over it. press ',
    kbd,
    ' any time for shortcuts.',
  );

  const row = document.createElement('div');
  row.className = 'sl-welcome-actions';
  const kao = document.createElement('span');
  kao.className = 'sl-welcome-kao';
  kao.textContent = '(=^..^=)';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'sl-welcome-dismiss';
  dismiss.textContent = 'got it';
  dismiss.addEventListener('click', () => {
    card.remove();
    onDismiss();
  });
  row.append(kao, dismiss);

  card.append(head, body, row);
  document.body.append(card);
  return () => card.remove();
}

/* DEV-only harness: lets e2e exercise the card before app wiring lands.
   Stripped from prod builds. */
if (import.meta.env.DEV) {
  (window as unknown as { __labWelcome?: object }).__labWelcome = {
    welcomeLine,
    mountFirstRunCard,
  };
}
