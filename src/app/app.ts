/** App — composition root: builds core/render/tools/ui/io and wires them via the bus. */
import type { Command, Tag } from '../core/contracts';
import { Bus } from '../core/bus';
import { History } from '../core/history';
import { SpriteDoc, type DocJson } from '../core/doc';
import demoRaw from '../assets/demo.sprite.json?raw';
import { AddPaletteColor } from '../core/commands/palette-ops';
import { RemovePaletteColor, ReplacePaletteColor, SetPalette } from '../core/commands/palette-edit';
import { SwapColors, usedColors } from '../core/commands/palette-swap';
import {
  AddFrame, DuplicateFrame, RemoveFrame, ReorderFrame, ReverseFrames, SetFrameDuration,
} from '../core/commands/frames-ops';
import {
  AddLayer, MergeLayerDown, RemoveLayer, RenameLayer, ReorderLayer,
  SetLayerOpacity, SetLayerVisible,
} from '../core/commands/layers-ops';
import { AddTag, RemoveTag, UpdateTag } from '../core/commands/tags-ops';
import { Camera } from '../render/camera';
import { Compositor } from '../render/compositor';
import { Viewport } from '../render/viewport';
import { PencilTool } from '../tools/pencil';
import { EraserTool } from '../tools/eraser';
import { EyedropperTool } from '../tools/eyedropper';
import { FillTool } from '../tools/fill';
import { LineTool } from '../tools/line';
import { RectTool } from '../tools/rect';
import { EllipseTool } from '../tools/ellipse';
import { SelectRectTool } from '../tools/select-rect';
import { LassoTool } from '../tools/lasso';
import { MoveTool } from '../tools/move';
import { Shell } from '../ui/shell';
import { Shortcuts } from '../ui/shortcuts';
import { ToolbarPanel } from '../ui/panels/toolbar';
import { ColorPanel } from '../ui/panels/color';
import { SwapPanel } from '../ui/panels/swap';
import { LayersPanel } from '../ui/panels/layers';
import { HistoryPanel } from '../ui/panels/history';
import { StatusBar } from '../ui/panels/status';
import { TimelinePanel } from '../ui/panels/timeline';
import { Autosave } from '../io/autosave';
import { installDragDrop, openFilePicker, type DecodedImage } from '../io/import';
import { downloadBlob, exportPng } from '../io/exporters/png';
import { downloadText } from '../io/palettes';
import { exportSheet, sheetFileName } from '../io/exporters/sheet';
import { canEncodeWebp } from '../io/exporters/webp';
import { framePxMap } from '../io/exporters/pxmap';
import { docToSpriteFile, openSpritePicker, spriteFileName } from '../io/project';
import { EncoderClient } from '../io/workers/protocol';
import { SheetImporter } from '../ui/panels/importer';
import { EditorState } from './editor';
import { Player } from './player';

const THEME_KEY = 'sprite-lab:v2:theme';
const DEMO_SEEN_KEY = 'sprite-lab:v2:demo-seen';
const DEMO_SEEN_COOKIE = 'sprite-lab-demo-seen';

/** The bundled first-run sprite (the mochi cat). null if the asset is corrupt. */
function demoDoc(): SpriteDoc | null {
  try {
    return SpriteDoc.fromJSON(JSON.parse(demoRaw) as DocJson);
  } catch {
    return null;
  }
}

/** First-run = the demo has never been shown on this origin. The marker lives
 *  in BOTH localStorage and a cookie so clearing one store alone doesn't
 *  resurrect the demo over a deliberately blank doc. */
function demoSeen(): boolean {
  try {
    if (localStorage.getItem(DEMO_SEEN_KEY) !== null) return true;
  } catch {
    /* storage unavailable */
  }
  return document.cookie.includes(`${DEMO_SEEN_COOKIE}=1`);
}

function markDemoSeen(): void {
  try {
    localStorage.setItem(DEMO_SEEN_KEY, '1');
  } catch {
    /* storage unavailable */
  }
  try {
    document.cookie = `${DEMO_SEEN_COOKIE}=1; max-age=63072000; path=/; SameSite=Lax`;
  } catch {
    /* cookies unavailable */
  }
}

export class App {
  private readonly root: HTMLElement;
  private mounted = false;
  private readonly teardown: Array<() => void> = [];

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /** Sync entry point (main.ts). Kicks the async boot — restore is OPFS-first. */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    void this.start();
  }

  /**
   * Boot order: restore autosave (OPFS → localStorage, else blank 32×32)
   * → core (doc/history/bus) → editor+tools → shell → viewport → panels
   * → shortcuts → autosave.start() → topbar actions (new/open/export/theme).
   */
  private async start(): Promise<void> {
    // First run (no autosave, demo never shown): boot into the demo sprite so
    // the app never opens cold-empty. The marker is written before the first
    // await so a reload mid-boot can never observe a half-marked first run.
    const firstRun = !demoSeen();
    if (firstRun) markDemoSeen();
    const restored = await Autosave.restoreAsync();
    if (!this.mounted) return;

    const doc = restored
      ?? (firstRun ? demoDoc() : null)
      ?? SpriteDoc.blank(32, 32, 'untitled');
    const bus = new Bus();
    const history = new History(doc, bus);
    const tools = [
      new PencilTool(), new EraserTool(), new EyedropperTool(), new FillTool(),
      new LineTool(), new RectTool(), new EllipseTool(),
      new SelectRectTool(), new LassoTool(), new MoveTool(),
    ];
    const editor = new EditorState(doc, history, bus, tools);
    this.teardown.push(() => editor.dispose());

    // Player is the sole 'playback:changed' emitter; the editor mirrors the
    // flag (syncPlaying never re-emits) and pauses playback on pointer-down.
    const player = new Player({
      bus,
      getDoc: () => editor.doc,
      getFrame: () => editor.activeFrame,
      setFrame: (i) => editor.setActiveFrame(i),
    });
    this.teardown.push(() => player.dispose());
    editor.setPauseHook(() => player.pause());
    this.teardown.push(bus.on('playback:changed', ({ playing }) => {
      editor.syncPlaying(playing);
    }));

    const camera = new Camera();
    const compositor = new Compositor(doc);

    const shell = new Shell();
    const slots = shell.mount(this.root);
    this.teardown.push(() => shell.unmount());

    const viewport = new Viewport({
      container: slots.canvas,
      bus,
      camera,
      compositor,
      delegate: editor,
      docW: doc.width,
      docH: doc.height,
    });
    viewport.mount();
    this.teardown.push(() => viewport.unmount());

    const undo = (): void => { if (history.canUndo) history.undo(); };
    const redo = (): void => { if (history.canRedo) history.redo(); };
    let opacityDrag: { index: number; cmd: Command; at: number } | null = null;

    const toolbar = new ToolbarPanel({
      host: slots.toolbar,
      bus,
      tools,
      getActive: () => editor.activeToolId,
      onSelect: (id) => editor.setTool(id),
      getBrush: () => editor.brushSize,
      onBrush: (size) => editor.setBrush(size),
      getSymmetry: () => editor.symmetry,
      onSymmetry: () => editor.cycleSymmetry(),
      getDither: () => editor.dither,
      onDither: () => editor.cycleDither(),
      onUndo: undo,
      onRedo: redo,
    });
    toolbar.mount();
    this.teardown.push(() => toolbar.unmount());

    const colorPanel = new ColorPanel({
      host: slots.side,
      bus,
      getColor: () => editor.color,
      setColor: (c) => editor.setColor(c),
      swapColors: () => editor.swapColors(),
      getPalette: () => editor.doc.palette,
      addColor: (c) => history.commit(new AddPaletteColor(c)),
      replaceColor: (index, c) => history.commit(new ReplacePaletteColor(index, c)),
      removeColor: (index) => history.commit(new RemovePaletteColor(index)),
      addRamp: (colors) => {
        const have = new Set(editor.doc.palette.colors);
        const fresh = colors.filter((c) => {
          if (have.has(c)) return false;
          have.add(c);
          return true;
        });
        if (fresh.length === 0) {
          bus.emit('status:message', { text: 'ramp colors already in palette' });
          return;
        }
        history.commit(new SetPalette([...editor.doc.palette.colors, ...fresh], null, 'add ramp'));
      },
      setPalette: (name, colors) => history.commit(new SetPalette(colors, name, 'load palette')),
      getDocName: () => editor.doc.meta.name,
    });
    colorPanel.mount();
    this.teardown.push(() => colorPanel.unmount());

    const swapPanel = new SwapPanel({
      host: slots.side,
      bus,
      getUsedColors: () => usedColors(editor.doc, 12),
      getCurrentColor: () => editor.color,
      applySwap: (pairs) => history.commit(new SwapColors(pairs)),
    });
    swapPanel.mount();
    this.teardown.push(() => swapPanel.unmount());

    const layersPanel = new LayersPanel({
      host: slots.side,
      bus,
      getDoc: () => editor.doc,
      getLayer: () => editor.activeLayer,
      setLayer: (i) => editor.setActiveLayer(i),
      addLayer: () => {
        const at = editor.activeLayer;
        history.commit(new AddLayer(at));
        editor.setActiveLayer(at + 1);
      },
      removeLayer: () => {
        if (editor.doc.layers.length <= 1) {
          bus.emit('status:message', { text: 'last layer' });
          return;
        }
        history.commit(new RemoveLayer(editor.activeLayer));
      },
      moveLayer: (dir) => {
        const from = editor.activeLayer;
        const to = from + dir;
        if (to < 0 || to >= editor.doc.layers.length) return;
        history.commit(new ReorderLayer(from, to));
        editor.setActiveLayer(to);
      },
      mergeDown: () => {
        const at = editor.activeLayer;
        if (at <= 0) return;
        history.commit(new MergeLayerDown(at));
        editor.setActiveLayer(at - 1);
      },
      // slider drags fire per input event — replace-last so a drag = one history entry.
      // Only ever undo OUR OWN last commit (identity via peekUndo), never a stranger's.
      setOpacity: (i, opacity) => {
        const now = performance.now();
        if (opacityDrag && (opacityDrag.index !== i || now - opacityDrag.at >= 600)) {
          opacityDrag = null;
        }
        if (opacityDrag && history.peekUndo() === opacityDrag.cmd) history.undo();
        const cmd = new SetLayerOpacity(i, opacity);
        history.commit(cmd);
        opacityDrag = { index: i, cmd, at: now };
      },
      endOpacityDrag: () => { opacityDrag = null; },
      setVisible: (i, visible) => history.commit(new SetLayerVisible(i, visible)),
      rename: (i, name) => history.commit(new RenameLayer(i, name)),
    });
    layersPanel.mount();
    this.teardown.push(() => layersPanel.unmount());

    const historyPanel = new HistoryPanel({
      host: slots.side,
      bus,
      entries: () => history.entries(),
      jumpTo: (i) => history.jumpTo(i),
    });
    historyPanel.mount();
    this.teardown.push(() => historyPanel.unmount());

    const statusBar = new StatusBar({
      host: slots.status,
      bus,
      getZoom: () => camera.zoom,
      getDocSize: () => ({ w: editor.doc.width, h: editor.doc.height }),
    });
    statusBar.mount();
    this.teardown.push(() => statusBar.unmount());

    const addFrameAfterActive = (): void => {
      const at = editor.activeFrame;
      history.commit(new AddFrame(at));
      editor.setActiveFrame(at + 1);
    };
    const duplicateActiveFrame = (): void => {
      const at = editor.activeFrame;
      history.commit(new DuplicateFrame(at));
      editor.setActiveFrame(at + 1);
    };
    let activeTag: number | null = null;
    let activeTagRef: Tag | null = null;
    const setRangeFromTag = (index: number | null): void => {
      const tag = index === null ? undefined : editor.doc.tags[index];
      activeTag = tag ? index : null;
      activeTagRef = tag ?? null;
      player.setRange(tag ? { from: tag.from, to: tag.to, mode: tag.mode } : null);
    };
    // Undo/redo of tag commands can delete or replace the tag the player loops —
    // re-derive it (identity first, stored index as fallback) on every frames change.
    this.teardown.push(bus.on('doc:changed', ({ scope }) => {
      if (scope.kind !== 'frames' && scope.kind !== 'all') return;
      if (activeTag === null) return;
      const tags = editor.doc.tags;
      const byIdentity = activeTagRef ? tags.indexOf(activeTagRef) : -1;
      const index = byIdentity !== -1 ? byIdentity : activeTag;
      const tag = tags[index];
      if (!tag) {
        setRangeFromTag(null);
        return;
      }
      activeTag = index;
      activeTagRef = tag;
      player.setRange({ from: tag.from, to: tag.to, mode: tag.mode });
    }));

    const timeline = new TimelinePanel({
      host: slots.timeline,
      bus,
      getDoc: () => editor.doc,
      getFrame: () => editor.activeFrame,
      setFrame: (i) => editor.setActiveFrame(i),
      addFrame: addFrameAfterActive,
      duplicateFrame: duplicateActiveFrame,
      removeFrame: () => {
        if (editor.doc.frames.length <= 1) {
          bus.emit('status:message', { text: 'last frame' });
          return;
        }
        history.commit(new RemoveFrame(editor.activeFrame));
      },
      reorderFrame: (from, to) => {
        const active = editor.activeFrame;
        history.commit(new ReorderFrame(from, to));
        if (active === from) editor.setActiveFrame(to);
        else if (from < active && to >= active) editor.setActiveFrame(active - 1);
        else if (from > active && to <= active) editor.setActiveFrame(active + 1);
      },
      reverseFrames: () => history.commit(new ReverseFrames()),
      setDuration: (i, ms) => history.commit(new SetFrameDuration(i, ms)),
      isPlaying: () => player.playing,
      togglePlay: () => player.toggle(),
      getOnion: () => editor.onion,
      setOnion: (config) => editor.setOnion(config),
      addTag: (tag) => history.commit(new AddTag(tag)),
      // the doc:changed subscription above re-derives the active range on commit
      removeTag: (index) => history.commit(new RemoveTag(index)),
      updateTag: (index, next) => history.commit(new UpdateTag(index, next)),
      setRangeFromTag,
    });
    timeline.mount();
    this.teardown.push(() => timeline.unmount());

    const adopt = (next: SpriteDoc): void => {
      player.pause();
      setRangeFromTag(null);
      editor.replaceDoc(next);
      compositor.setDoc(next);
      viewport.setDocSize(next.width, next.height);
    };

    const importer = new SheetImporter({ bus, adopt });
    this.teardown.push(() => importer.dispose());

    // Big images (>96px either way) or 'sheet'-named files → slicing importer.
    const openImage = (img: DecodedImage): void => {
      if (img.w > 96 || img.h > 96 || img.name.toLowerCase().includes('sheet')) {
        importer.open(img.pixels, img.w, img.h, img.name);
      } else {
        adopt(SpriteDoc.fromImage(img.pixels, img.w, img.h, img.name));
      }
    };

    const encoder = new EncoderClient();
    this.teardown.push(() => encoder.dispose());
    const status = (text: string): void => bus.emit('status:message', { text });

    const toggleTheme = (): void => {
      const next = document.documentElement.dataset['theme'] === 'light' ? 'dark' : 'light';
      document.documentElement.dataset['theme'] = next;
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* storage unavailable */
      }
      bus.emit('theme:changed', { theme: next });
    };

    const actionsHost =
      slots.topbar.querySelector<HTMLElement>('.sl-topbar-actions') ?? slots.topbar;
    const addAction = (cls: string, text: string, onClick: () => void): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = cls;
      button.textContent = text;
      button.addEventListener('click', onClick);
      actionsHost.appendChild(button);
      this.teardown.push(() => {
        button.removeEventListener('click', onClick);
        button.remove();
      });
    };
    // A doc is worth a confirm when it has history in either direction OR any
    // painted pixel (a freshly-opened file has pixels but an empty history).
    const docHasPixels = (): boolean => {
      const d = editor.doc;
      for (const frame of d.frames) {
        for (const [, buf] of d.celEntriesForFrame(frame.id)) {
          for (const v of buf) if (v !== 0) return true;
        }
      }
      return false;
    };
    addAction('sl-act-new', 'new', () => {
      const dirty = history.canUndo || history.canRedo || docHasPixels();
      if (dirty && !window.confirm('Discard the current sprite?')) return;
      adopt(SpriteDoc.blank(32, 32, 'untitled'));
    });
    addAction('sl-act-open', 'open', () => openFilePicker(openImage, adopt, status));
    addAction('sl-act-export', 'export', () => {
      void exportPng(editor.doc, editor.activeFrame)
        .then((blob) => downloadBlob(blob, `${editor.doc.meta.name}.png`))
        .catch(() => status('png export failed'));
    });

    const exportSheetJson = (): void => {
      const name = editor.doc.meta.name;
      void exportSheet(editor.doc)
        .then(({ png, json }) => {
          downloadBlob(png, sheetFileName(name));
          downloadText(json, `${name}.sheet.json`);
        })
        .catch(() => status('sheet export failed'));
    };

    // Flatten a frame into a fresh, transferable ArrayBuffer for the worker.
    const framePayload = (i: number): { pixels: ArrayBuffer; durationMs: number } => {
      const flat = editor.doc.flattenFrame(i);
      const pixels = new ArrayBuffer(flat.byteLength);
      new Uint32Array(pixels).set(flat);
      return { pixels, durationMs: editor.doc.frames[i]?.durationMs ?? 100 };
    };

    const exportGif = (): void => {
      const d = editor.doc;
      const frames = d.frames.map((_, i) => framePayload(i));
      void encoder
        .request(
          { kind: 'gif', w: d.width, h: d.height, frames },
          frames.map((f) => f.pixels),
          (done, total) => status(`encoding gif ${done}/${total}`),
        )
        .then((blob) => downloadBlob(blob, `${d.meta.name}.gif`))
        .catch(() => status('gif export failed'));
    };

    const exportWebpAnim = async (): Promise<void> => {
      if (!(await canEncodeWebp())) {
        status('animated webp needs a chromium browser — try gif');
        return;
      }
      const d = editor.doc;
      const total = d.frames.length;
      const frames: Array<{ payload: ArrayBuffer; durationMs: number }> = [];
      for (let i = 0; i < total; i++) {
        const flat = d.flattenFrame(i);
        const canvas = new OffscreenCanvas(d.width, d.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
        const img = ctx.createImageData(d.width, d.height);
        img.data.set(new Uint8ClampedArray(flat.buffer, flat.byteOffset, flat.length * 4));
        ctx.putImageData(img, 0, 0);
        // quality 1 → Chromium emits lossless VP8L; the default is lossy VP8
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1 });
        frames.push({ payload: await blob.arrayBuffer(), durationMs: d.frames[i]?.durationMs ?? 100 });
        status(`encoding webp ${i + 1}/${total}`);
      }
      const out = await encoder.request(
        { kind: 'webp-mux', w: d.width, h: d.height, frames },
        frames.map((f) => f.payload),
      );
      downloadBlob(out, `${d.meta.name}.webp`);
    };

    const exportPxSnippet = (): void => {
      let snippet: string;
      try {
        snippet = framePxMap(editor.doc, editor.activeFrame);
      } catch (err) {
        status(err instanceof Error ? err.message : 'px map export failed');
        return;
      }
      const fallback = (): void => {
        downloadText(snippet, `${editor.doc.meta.name}.pxmap.ts`);
        status('px map downloaded');
      };
      try {
        navigator.clipboard.writeText(snippet).then(() => status('px map copied'), fallback);
      } catch {
        fallback();
      }
    };

    this.mountExportMenu(actionsHost, [
      { label: 'sheet + json', run: exportSheetJson },
      { label: 'gif', run: exportGif },
      {
        label: 'animated webp',
        run: () => { void exportWebpAnim().catch(() => status('webp export failed')); },
      },
      { label: 'px map', run: exportPxSnippet },
      {
        label: 'save .sprite',
        run: () => downloadBlob(docToSpriteFile(editor.doc), spriteFileName(editor.doc)),
      },
      { label: 'open .sprite', run: () => openSpritePicker(adopt, status) },
      {
        label: 'open demo',
        cls: 'sl-act-demo',
        run: () => {
          const demo = demoDoc();
          if (demo) adopt(demo);
          else status('demo sprite unavailable');
        },
      },
    ]);
    addAction('sl-act-theme', 'theme', toggleTheme);

    this.teardown.push(installDragDrop(openImage, adopt, status));

    const autosave = new Autosave(bus, () => editor.doc);
    autosave.start();
    this.teardown.push(() => autosave.stop());

    const shortcuts = new Shortcuts();
    for (const tool of editor.tools) {
      shortcuts.register({
        keys: tool.hotkey,
        desc: tool.label,
        group: 'tools',
        run: () => editor.setTool(tool.id),
      });
    }
    shortcuts.register({ keys: 'mod+z', desc: 'undo', group: 'edit', run: undo });
    shortcuts.register({ keys: 'mod+shift+z', desc: 'redo', group: 'edit', run: redo });
    shortcuts.register({ keys: 'mod+y', desc: 'redo', group: 'edit', run: redo });
    shortcuts.register({
      keys: 'mod+a', desc: 'select all', group: 'edit', run: () => editor.selectAll(),
    });
    shortcuts.register({
      keys: 'mod+d', desc: 'deselect', group: 'edit', run: () => editor.deselect(),
    });
    shortcuts.register({
      keys: 'mod+c', desc: 'copy', group: 'edit', run: () => editor.copySelection(),
    });
    shortcuts.register({
      keys: 'mod+x', desc: 'cut', group: 'edit', run: () => editor.cutSelection(),
    });
    shortcuts.register({
      keys: 'mod+v', desc: 'paste', group: 'edit', run: () => editor.paste(),
    });
    shortcuts.register({
      keys: 'escape', desc: 'anchor float / deselect', group: 'edit',
      run: () => { editor.cancelOrDismiss(); },
    });
    shortcuts.register({
      keys: 's', desc: 'cycle symmetry', group: 'tools', run: () => editor.cycleSymmetry(),
    });
    shortcuts.register({
      keys: 'd', desc: 'cycle dither', group: 'tools', run: () => editor.cycleDither(),
    });
    shortcuts.register({
      keys: 'x', desc: 'swap colors', group: 'tools', run: () => editor.swapColors(),
    });
    shortcuts.register({
      keys: '[', desc: 'smaller brush', group: 'tools',
      run: () => editor.setBrush(editor.brushSize - 1),
    });
    shortcuts.register({
      keys: ']', desc: 'larger brush', group: 'tools',
      run: () => editor.setBrush(editor.brushSize + 1),
    });
    const zoomAt = (dir: 1 | -1): void => {
      camera.zoomStep(dir, slots.canvas.clientWidth / 2, slots.canvas.clientHeight / 2);
      bus.emit('camera:changed');
    };
    shortcuts.register({ keys: '+', desc: 'zoom in', group: 'canvas', run: () => zoomAt(1) });
    // '=' is an unshifted alias for '+' — active, but not a separate cheat-sheet row
    shortcuts.register({
      keys: '=', desc: 'zoom in', group: 'canvas', hidden: true, run: () => zoomAt(1),
    });
    shortcuts.register({ keys: '-', desc: 'zoom out', group: 'canvas', run: () => zoomAt(-1) });
    shortcuts.register({
      keys: '0', desc: 'fit view', group: 'canvas',
      run: () => {
        camera.fit(
          editor.doc.width, editor.doc.height,
          slots.canvas.clientWidth, slots.canvas.clientHeight,
        );
        bus.emit('camera:changed');
      },
    });
    shortcuts.register({
      keys: ',', desc: 'toggle grid', group: 'canvas', run: () => viewport.toggleGrid(),
    });
    shortcuts.register({
      keys: '.', desc: 'tiling preview', group: 'canvas', run: () => viewport.toggleTiling(),
    });
    shortcuts.register({ keys: 't', desc: 'toggle theme', group: 'app', run: toggleTheme });
    const stepFrame = (dir: 1 | -1): void => {
      const count = editor.doc.frames.length;
      editor.setActiveFrame((editor.activeFrame + dir + count) % count);
    };
    shortcuts.register({
      keys: 'arrowleft', desc: 'previous frame', group: 'anim', run: () => stepFrame(-1),
    });
    shortcuts.register({
      keys: 'arrowright', desc: 'next frame', group: 'anim', run: () => stepFrame(1),
    });
    shortcuts.register({
      keys: 'enter', desc: 'play / pause', group: 'anim', run: () => player.toggle(),
    });
    shortcuts.register({
      keys: 'n', desc: 'new frame', group: 'anim', run: addFrameAfterActive,
    });
    shortcuts.register({
      keys: 'shift+n', desc: 'duplicate frame', group: 'anim', run: duplicateActiveFrame,
    });
    shortcuts.register({
      keys: 'k', desc: 'toggle onion skin', group: 'anim',
      run: () => editor.setOnion({ ...editor.onion, enabled: !editor.onion.enabled }),
    });
    shortcuts.register({
      keys: 'p', desc: 'toggle pen pressure', group: 'tools',
      run: () => {
        viewport.penPressure = !viewport.penPressure;
        bus.emit('status:message', {
          text: viewport.penPressure ? 'pen pressure on' : 'pen pressure off',
        });
      },
    });
    shortcuts.register({
      keys: 'pageup', desc: 'layer up', group: 'anim',
      run: () => editor.setActiveLayer(editor.activeLayer + 1),
    });
    shortcuts.register({
      keys: 'pagedown', desc: 'layer down', group: 'anim',
      run: () => editor.setActiveLayer(editor.activeLayer - 1),
    });
    this.teardown.push(shortcuts.attach());

    if (import.meta.env.DEV) {
      (window as unknown as { __lab?: object }).__lab = { editor, history, camera, bus };
      this.teardown.push(() => {
        delete (window as unknown as { __lab?: object }).__lab;
      });
    }
  }

  /** 'export…' topbar button + anchored dropdown. Closes on outside click / Esc;
   *  ArrowUp/ArrowDown walk the items. sl-act-export stays a direct png button. */
  private mountExportMenu(
    host: HTMLElement,
    items: ReadonlyArray<{ label: string; cls?: string; run: () => void }>,
  ): void {
    const wrap = document.createElement('div');
    wrap.className = 'sl-menu-anchor';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sl-act-more';
    button.textContent = 'export…';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.className = 'sl-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const buttons: HTMLButtonElement[] = [];
    const close = (): void => {
      if (menu.hidden) return;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    };
    const open = (): void => {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      buttons[0]?.focus();
    };

    for (const { label, cls, run } of items) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = cls ? `sl-menu-item ${cls}` : 'sl-menu-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = label;
      item.addEventListener('click', () => {
        close();
        button.focus();
        run();
      });
      buttons.push(item);
      menu.appendChild(item);
    }

    const onToggle = (): void => {
      if (menu.hidden) open();
      else close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (menu.hidden) {
        if (e.key === 'ArrowDown' && document.activeElement === button) {
          e.preventDefault();
          open();
        }
        return;
      }
      const step = (dir: 1 | -1): void => {
        const at = buttons.findIndex((b) => b === document.activeElement);
        const next = at < 0
          ? (dir === 1 ? 0 : buttons.length - 1)
          : (at + dir + buttons.length) % buttons.length;
        buttons[next]?.focus();
      };
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        button.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        step(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        step(-1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        // keep the global Enter=play/space=pan shortcuts out of item activation;
        // the button's default click still fires
        e.stopPropagation();
      }
    };
    const onOutside = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || !wrap.contains(e.target)) close();
    };
    button.addEventListener('click', onToggle);
    wrap.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onOutside);

    wrap.append(button, menu);
    host.appendChild(wrap);
    this.teardown.push(() => {
      button.removeEventListener('click', onToggle);
      wrap.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onOutside);
      wrap.remove();
    });
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const dispose of this.teardown.splice(0).reverse()) dispose();
  }
}
