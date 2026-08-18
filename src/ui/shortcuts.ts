/**
 * Central keymap. Every binding registers here; '?' renders the cheat sheet
 * from the registry (never hand-maintained). Skips events while typing in
 * inputs. Key syntax: 'b', 'shift+g', 'mod+z' (mod = ⌘ on mac, ctrl elsewhere).
 * The sheet itself rides the shared Modal (Wave 9) — key swallowing, focus
 * trap and scroll lock come from there; '?'-to-close is a capture listener
 * registered BEFORE the modal opens so it wins the capture order.
 */
import { Modal } from './modal';

export interface ShortcutDef {
  keys: string;
  desc: string;
  group: string; // cheat-sheet section: 'tools' | 'canvas' | 'edit' | 'anim' | 'app'
  /** Alias bindings: active, but omitted from the cheat sheet. */
  hidden?: boolean;
  run: () => void;
}

const GROUP_ORDER = ['tools', 'canvas', 'edit', 'anim', 'app'];

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

/** Display-only cheat-sheet rows for pointer gestures — nothing to bind. */
interface GestureNote {
  group: string;
  desc: string;
  /** Combo strings rendered like key combos ('scroll', 'mod+scroll'). */
  keys: string[];
}

export class Shortcuts {
  private readonly mac = isMacPlatform();
  private readonly bySig = new Map<string, ShortcutDef[]>();
  private readonly ordered: ShortcutDef[] = [];
  private sheetModal: Modal | null = null;
  private readonly notes: readonly GestureNote[] = [
    { group: 'canvas', desc: 'pan · zoom', keys: ['scroll', 'mod+scroll'] },
  ];

  /** While the sheet is open the Modal swallows every non-typing key, so the
   *  '?' toggle must live on its own capture listener (added before the modal
   *  opens — earlier registration on the same target fires first). */
  private readonly onSheetKey = (e: KeyboardEvent): void => {
    if (normalizeKeyName(e.key) === '?') {
      e.preventDefault();
      e.stopPropagation();
      this.closeCheatSheet();
    }
  };

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
    if (!def.hidden) this.ordered.push(def);
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
    if (this.sheetModal) this.closeCheatSheet();
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
    // While the sheet is open the Modal's capture guard starves this handler;
    // Esc closes via Modal, '?' via onSheetKey.
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
    if (this.sheetModal) return;
    const modal = new Modal({
      label: 'keyboard shortcuts',
      className: 'sl-cheatsheet',
      onClose: () => {
        window.removeEventListener('keydown', this.onSheetKey, true);
        this.sheetModal = null;
      },
    });

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
    const nameSet = new Set([...byGroup.keys(), ...this.notes.map((n) => n.group)]);
    const names = [...nameSet].sort((a, b) => rank(a) - rank(b));

    const row = (desc: string, combos: string[]): HTMLElement => {
      const el = document.createElement('div');
      el.className = 'sl-cheat-row';
      const descEl = document.createElement('span');
      descEl.className = 'sl-cheat-desc';
      descEl.textContent = desc;
      const keysEl = document.createElement('span');
      keysEl.className = 'sl-cheat-keys';
      combos.forEach((combo, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'sl-cheat-sep';
          sep.textContent = '·';
          keysEl.appendChild(sep);
        }
        for (const token of this.displayTokens(combo)) {
          const kbd = document.createElement('kbd');
          kbd.textContent = token;
          keysEl.appendChild(kbd);
        }
      });
      el.append(descEl, keysEl);
      return el;
    };

    const groups = document.createElement('div');
    groups.className = 'sl-cheatsheet-groups';
    for (const name of names) {
      const defs = byGroup.get(name) ?? [];
      const notes = this.notes.filter((n) => n.group === name);
      if (defs.length === 0 && notes.length === 0) continue;
      const group = document.createElement('div');
      group.className = 'sl-cheat-group';
      const groupTitle = document.createElement('div');
      groupTitle.className = 'sl-cheat-group-title';
      groupTitle.textContent = name;
      group.appendChild(groupTitle);
      for (const def of defs) group.appendChild(row(def.desc, [def.keys]));
      for (const note of notes) group.appendChild(row(note.desc, note.keys));
      groups.appendChild(group);
    }

    modal.root.append(head, groups);
    window.addEventListener('keydown', this.onSheetKey, true);
    this.sheetModal = modal;
    modal.open();
  }

  private closeCheatSheet(): void {
    this.sheetModal?.close();
  }
}
