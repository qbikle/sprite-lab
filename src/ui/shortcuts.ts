/**
 * Central keymap. Every binding registers here; '?' renders the cheat sheet
 * from the registry (never hand-maintained). Skips events while typing in
 * inputs. Key syntax: 'b', 'shift+g', 'mod+z' (mod = ⌘ on mac, ctrl elsewhere).
 */

export interface ShortcutDef {
  keys: string;
  desc: string;
  group: string; // cheat-sheet section: 'tools' | 'canvas' | 'edit' | 'app'
  run: () => void;
}

const GROUP_ORDER = ['tools', 'canvas', 'edit', 'app'];

function isMacPlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function normalizeKeyName(raw: string): string {
  const k = raw.toLowerCase();
  if (k === ' ' || k === 'spacebar') return 'space';
  if (k === 'esc') return 'escape';
  return k;
}

/** Shift is part of the match only for named keys and alphanumerics — shifted
 *  punctuation ('?', '+', '{') already arrives as the printed character. */
function shiftCounts(key: string): boolean {
  return key.length !== 1 || /[a-z0-9]/.test(key);
}

function buildSig(key: string, ctrl: boolean, meta: boolean, shift: boolean, alt: boolean): string {
  const s = shift && shiftCounts(key);
  return `${ctrl ? 'C' : ''}${meta ? 'M' : ''}${alt ? 'A' : ''}${s ? 'S' : ''}:${key}`;
}

/** Split 'mod+shift+z' into modifier tokens + key; tolerates '+' as the key. */
function splitCombo(keys: string): { mods: string[]; key: string } {
  const parts = keys.trim().toLowerCase().split('+');
  let key = parts.pop() ?? '';
  if (key === '') {
    key = '+';
    if (parts[parts.length - 1] === '') parts.pop();
  }
  return { mods: parts, key: normalizeKeyName(key) };
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) {
    return true;
  }
  return t.isContentEditable;
}

export class Shortcuts {
  private readonly mac = isMacPlatform();
  private readonly bySig = new Map<string, ShortcutDef[]>();
  private readonly ordered: ShortcutDef[] = [];
  private sheet: HTMLElement | null = null;

  constructor() {
    this.register({
      keys: '?',
      desc: 'keyboard cheat sheet',
      group: 'app',
      run: () => this.toggleCheatSheet(),
    });
  }

  register(def: ShortcutDef): void {
    const sig = this.comboSignature(def.keys);
    const list = this.bySig.get(sig);
    if (list) list.push(def);
    else this.bySig.set(sig, [def]);
    this.ordered.push(def);
  }

  /** Attach the document keydown listener. Returns detach. */
  attach(): () => void {
    const onKeyDown = (e: KeyboardEvent): void => this.handle(e);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      this.closeCheatSheet();
    };
  }

  toggleCheatSheet(): void {
    if (this.sheet) this.closeCheatSheet();
    else this.openCheatSheet();
  }

  private comboSignature(keys: string): string {
    const { mods, key } = splitCombo(keys);
    let ctrl = false;
    let meta = false;
    let shift = false;
    let alt = false;
    for (const mod of mods) {
      if (mod === 'mod') {
        if (this.mac) meta = true;
        else ctrl = true;
      } else if (mod === 'ctrl' || mod === 'control') ctrl = true;
      else if (mod === 'meta' || mod === 'cmd') meta = true;
      else if (mod === 'shift') shift = true;
      else if (mod === 'alt' || mod === 'opt' || mod === 'option') alt = true;
    }
    return buildSig(key, ctrl, meta, shift, alt);
  }

  private handle(e: KeyboardEvent): void {
    const key = normalizeKeyName(e.key);
    if (this.sheet) {
      if (key === 'escape' || key === '?') {
        e.preventDefault();
        this.closeCheatSheet();
      }
      return;
    }
    if (isTypingTarget(e.target) && key !== 'escape') return;
    const sig = buildSig(key, e.ctrlKey, e.metaKey, e.shiftKey, e.altKey);
    const defs = this.bySig.get(sig);
    if (!defs || defs.length === 0) return;
    e.preventDefault();
    for (const def of defs) def.run();
  }

  private displayTokens(keys: string): string[] {
    const { mods, key } = splitCombo(keys);
    const out: string[] = [];
    for (const mod of mods) {
      if (mod === 'mod') out.push(this.mac ? 'cmd' : 'ctrl');
      else if (mod === 'alt' || mod === 'opt' || mod === 'option') out.push(this.mac ? 'opt' : 'alt');
      else out.push(mod);
    }
    const shown = key === 'escape' ? 'esc' : key;
    out.push(shown.length === 1 ? shown.toUpperCase() : shown);
    return out;
  }

  private openCheatSheet(): void {
    const overlay = document.createElement('div');
    overlay.className = 'sl-cheatsheet';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'keyboard shortcuts');

    const panel = document.createElement('div');
    panel.className = 'sl-cheatsheet-panel';

    const head = document.createElement('div');
    head.className = 'sl-cheatsheet-head';
    const title = document.createElement('div');
    title.className = 'sl-cheatsheet-title';
    title.textContent = 'keyboard';
    const hint = document.createElement('div');
    hint.className = 'sl-cheatsheet-hint';
    hint.textContent = 'esc to close';
    head.append(title, hint);

    const byGroup = new Map<string, ShortcutDef[]>();
    for (const def of this.ordered) {
      const list = byGroup.get(def.group);
      if (list) list.push(def);
      else byGroup.set(def.group, [def]);
    }
    const rank = (g: string): number => {
      const i = GROUP_ORDER.indexOf(g);
      return i === -1 ? GROUP_ORDER.length : i;
    };
    const names = [...byGroup.keys()].sort((a, b) => rank(a) - rank(b));

    const groups = document.createElement('div');
    groups.className = 'sl-cheatsheet-groups';
    for (const name of names) {
      const defs = byGroup.get(name);
      if (!defs) continue;
      const group = document.createElement('div');
      group.className = 'sl-cheat-group';
      const groupTitle = document.createElement('div');
      groupTitle.className = 'sl-cheat-group-title';
      groupTitle.textContent = name;
      group.appendChild(groupTitle);
      for (const def of defs) {
        const row = document.createElement('div');
        row.className = 'sl-cheat-row';
        const desc = document.createElement('span');
        desc.className = 'sl-cheat-desc';
        desc.textContent = def.desc;
        const keysEl = document.createElement('span');
        keysEl.className = 'sl-cheat-keys';
        for (const token of this.displayTokens(def.keys)) {
          const kbd = document.createElement('kbd');
          kbd.textContent = token;
          keysEl.appendChild(kbd);
        }
        row.append(desc, keysEl);
        group.appendChild(row);
      }
      groups.appendChild(group);
    }

    panel.append(head, groups);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) this.closeCheatSheet();
    });
    document.body.appendChild(overlay);
    this.sheet = overlay;
  }

  private closeCheatSheet(): void {
    if (!this.sheet) return;
    this.sheet.remove();
    this.sheet = null;
  }
}
