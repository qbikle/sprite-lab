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
import { ResizeCanvas } from '../core/commands/resize';
import { FlipFrameX, FlipFrameY, Rotate90CW } from '../core/commands/transform';
import { upscaleNearest } from '../core/pixels';
import { Shell } from '../ui/shell';

import { closeAllModals, confirmModal } from '../ui/modal';
import { mountFirstRunCard, welcomeLine } from '../ui/welcome';
import { docFromChoice, openNewDocModal, openResizeModal } from '../ui/panels/newdoc';
import { openExportModal } from '../ui/panels/exportmodal';
import { PreviewPanel } from '../ui/panels/preview';
import { openArcade, setRemixParent } from '../ui/panels/arcade';
import type { ArcadePost } from '../net/arcade';
import { Shortcuts } from '../ui/shortcuts';
import { ToolbarPanel } from '../ui/panels/toolbar';
import { ColorPanel } from '../ui/panels/color';
import { SwapPanel } from '../ui/panels/swap';
import { LayersPanel } from '../ui/panels/layers';
import { HistoryPanel } from '../ui/panels/history';
import { StatusBar } from '../ui/panels/status';
import { TimelinePanel } from '../ui/panels/timeline';
import { Autosave } from '../io/autosave';
import { installDragDrop, installPaste, openFilePicker, type DecodedImage } from '../io/import';
import { downloadBlob, exportPng } from '../io/exporters/png';
import { downloadText } from '../io/palettes';
import { exportSheet, sheetFileName } from '../io/exporters/sheet';
import { canEncodeWebp } from '../io/exporters/webp';
import { framePxMap } from '../io/exporters/pxmap';
import { docToSpriteFile, spriteFileName } from '../io/project';
import { EncoderClient } from '../io/workers/protocol';
import { SheetImporter } from '../ui/panels/importer';
import { StampTool } from '../tools/stamp';
import { StampsPanel } from '../ui/panels/stamps';
import { selectionPixels } from './stamps';
import { captureTimelapse } from './timelapse';
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
      new SelectRectTool(), new LassoTool(), new MoveTool(), new StampTool(bus),
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

    // ResizeCanvas (and its undo/redo) changes doc dims via a plain 'all'
    // commit — the compositor and viewport must re-seat at the new size.
    // Hooked on the bus so commit, undo, and redo all take the same route;
    // 'all' also fires for SwapColors etc., hence the dims check. Safe order:
    // viewport's own doc:changed handler only marks dirty — rendering is
    // rAF-deferred, so the realloc below lands before any paint.
    let docDims = { w: doc.width, h: doc.height };
    this.teardown.push(bus.on('doc:changed', ({ scope }) => {
      if (scope.kind !== 'all') return;
      const d = editor.doc;
      if (d.width === docDims.w && d.height === docDims.h) return;
      docDims = { w: d.width, h: d.height };
      compositor.setDoc(d);
      viewport.setDocSize(d.width, d.height);
    }));
    this.teardown.push(bus.on('doc:replaced', () => {
      docDims = { w: editor.doc.width, h: editor.doc.height };
    }));

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
      onFlipX: () => {
        if (editor.float) editor.cancelOrDismiss(); // anchor float so its pixels flip too
        history.commit(new FlipFrameX(editor.activeFrame));
      },
      onFlipY: () => {
        if (editor.float) editor.cancelOrDismiss();
        history.commit(new FlipFrameY(editor.activeFrame));
      },
      onRotate: () => {
        editor.cancelOrDismiss(); // anchor a live float (undoable)
        editor.cancelOrDismiss(); // then drop the selection — both doc-sized
        history.commit(new Rotate90CW());
      },
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
      onSizeClick: () =>
        openResizeModal({
          width: editor.doc.width,
          height: editor.doc.height,
          onResize: (w, h, anchor) => {
            editor.cancelOrDismiss(); // anchor a live float (undoable)
            editor.cancelOrDismiss(); // then drop the selection — both doc-sized
            history.commit(new ResizeCanvas(w, h, anchor));
          },
        }),
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

    // Preview owns a DEDICATED compositor — sharing the viewport's would
    // thrash its single-frame composite cache every preview tick.
    const preview = new PreviewPanel({
      host: slots.side,
      bus,
      compositor: new Compositor(doc),
      getDoc: () => editor.doc,
      getRange: () => activeTagRef,
    });
    preview.mount();
    this.teardown.push(() => preview.unmount());

    const stampsPanel = new StampsPanel({
      host: slots.side,
      bus,
      getSelectionPixels: () => selectionPixels(editor),
      onUseStamp: () => {
        editor.cancelOrDismiss(); // anchor a live float (undoable)
        editor.cancelOrDismiss(); // then drop the selection — stamping is selection-gated
        editor.setTool('stamp');
      },
    });
    stampsPanel.mount();
    this.teardown.push(() => stampsPanel.unmount());

    const adopt = (next: SpriteDoc): void => {
      setRemixParent(null); // any non-remix adoption voids stale lineage
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
      const proceed = dirty
        ? confirmModal({
            title: 'new sprite',
            body: 'discard the current sprite?',
            confirmLabel: 'discard',
            danger: true,
          })
        : Promise.resolve(true);
      void proceed.then((ok) => {
        if (!ok) return;
        openNewDocModal({
          currentPalette: () => [...editor.doc.palette.colors],
          onCreate: (c) => adopt(docFromChoice(c, editor.doc.palette.colors)),
          onDemo: () => {
            const demo = demoDoc();
            if (demo) adopt(demo);
            else status('demo sprite unavailable');
          },
        });
      });
    });
    addAction('sl-act-open', 'open', () => openFilePicker(openImage, adopt, status));
    const exportPngFrame = (scale = 1): void => {
      void exportPng(editor.doc, editor.activeFrame, scale)
        .then((blob) => downloadBlob(blob, `${editor.doc.meta.name}.png`))
        .catch(() => status('png export failed'));
    };

    const exportSheetJson = (scale = 1): void => {
      const name = editor.doc.meta.name;
      void exportSheet(editor.doc, scale)
        .then(({ png, json }) => {
          downloadBlob(png, sheetFileName(name));
          downloadText(json, `${name}.sheet.json`);
        })
        .catch(() => status('sheet export failed'));
    };

    // Flatten a frame (pre-upscaled for the worker — protocol dims are params).
    const framePayload = (i: number, scale: number): { pixels: ArrayBuffer; durationMs: number } => {
      const flat = editor.doc.flattenFrame(i);
      const scaled = scale === 1 ? flat
        : upscaleNearest(flat, editor.doc.width, editor.doc.height, scale);
      const pixels = new ArrayBuffer(scaled.byteLength);
      new Uint32Array(pixels).set(scaled);
      return { pixels, durationMs: editor.doc.frames[i]?.durationMs ?? 100 };
    };

    const exportGif = (scale = 1): void => {
      const d = editor.doc;
      const frames = d.frames.map((_, i) => framePayload(i, scale));
      void encoder
        .request(
          { kind: 'gif', w: d.width * scale, h: d.height * scale, frames },
          frames.map((f) => f.pixels),
          (done, total) => status(`encoding gif ${done}/${total}`),
        )
        .then((blob) => downloadBlob(blob, `${d.meta.name}.gif`))
        .catch(() => status('gif export failed'));
    };

    const exportWebpAnim = async (scale = 1): Promise<void> => {
      if (!(await canEncodeWebp())) {
        status('animated webp needs a chromium browser — try gif');
        return;
      }
      const d = editor.doc;
      const w = d.width * scale;
      const h = d.height * scale;
      const total = d.frames.length;
      // Snapshot every frame SYNCHRONOUSLY before the first await — the app
      // stays interactive between per-frame encodes, and live edits (or a
      // resize) mid-export would otherwise produce a chimera file or throw.
      const flats = d.frames.map((_, i) => d.flattenFrame(i));
      const durations = d.frames.map((f) => f.durationMs);
      const frames: Array<{ payload: ArrayBuffer; durationMs: number }> = [];
      for (let i = 0; i < total; i++) {
        const flat = flats[i];
        if (flat === undefined) continue;
        const scaled = scale === 1 ? flat : upscaleNearest(flat, d.width, d.height, scale);
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
        const img = ctx.createImageData(w, h);
        img.data.set(new Uint8ClampedArray(scaled.buffer, scaled.byteOffset, scaled.length * 4));
        ctx.putImageData(img, 0, 0);
        // quality 1 → Chromium emits lossless VP8L; the default is lossy VP8
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 1 });
        frames.push({ payload: await blob.arrayBuffer(), durationMs: durations[i] ?? 100 });
        status(`encoding webp ${i + 1}/${total}`);
      }
      const out = await encoder.request(
        { kind: 'webp-mux', w, h, frames },
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

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'sl-act-more'; // class + label kept from the menu era
    trigger.textContent = 'export';
    trigger.setAttribute('aria-haspopup', 'dialog');
    const openExport = (): void =>
      openExportModal({
        doc: () => editor.doc,
        activeFrame: () => editor.activeFrame,
        canWebp: canEncodeWebp,
        canTimelapse: () => history.entries().cursor >= 2,
        run: {
          png: ({ scale }) => exportPngFrame(scale),
          sheet: ({ scale }) => exportSheetJson(scale),
          gif: ({ scale }) => exportGif(scale),
          webp: ({ scale }) => {
            void exportWebpAnim(scale).catch(() => status('webp export failed'));
          },
          pxmap: exportPxSnippet,
          sprite: () => downloadBlob(docToSpriteFile(editor.doc), spriteFileName(editor.doc)),
          timelapse: ({ scale }) => {
            // NO commits here — a commit truncates the user's redo tail, and
            // capture promises to leave history exactly as found. A live
            // selection/float rides the walk like user-driven undo/redo does.
            player.pause();
            const keepFrame = editor.activeFrame;
            const keepLayer = editor.activeLayer;
            const cam = { zoom: camera.zoom, panX: camera.panX, panY: camera.panY };
            const result = captureTimelapse({
              history,
              editor,
              scale,
              onProgress: (done, total) => status(`capturing timelapse ${done}/${total}`),
            });
            // The walk's structural undos clamp active indices down and its
            // dims transitions refit the camera — restore the user's seat.
            editor.setActiveFrame(keepFrame);
            editor.setActiveLayer(keepLayer);
            camera.zoom = cam.zoom;
            camera.panX = cam.panX;
            camera.panY = cam.panY;
            bus.emit('camera:changed');
            if (!result) {
              status('nothing to replay — draw something first');
              return;
            }
            void encoder
              .request(
                { kind: 'gif', w: result.w, h: result.h, frames: result.frames },
                result.frames.map((f) => f.pixels),
                (done, total) => status(`encoding timelapse ${done}/${total}`),
              )
              .then((blob) => downloadBlob(blob, `${editor.doc.meta.name}-timelapse.gif`))
              .catch(() => status('timelapse export failed'));
          },
        },
      });
    trigger.addEventListener('click', openExport);
    // The global Enter=play shortcut preventDefaults before the button's native
    // activation — keyboard opening needs its own keys (menu-era Enter gotcha).
    const onTriggerKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        openExport();
      }
    };
    trigger.addEventListener('keydown', onTriggerKey);
    actionsHost.appendChild(trigger);
    this.teardown.push(() => {
      trigger.removeEventListener('click', openExport);
      trigger.removeEventListener('keydown', onTriggerKey);
      trigger.remove();
    });
    addAction('sl-act-arcade', 'arcade', () => {
      openArcade({
        getDoc: () => editor.doc,
        adoptRemix: (remixDoc: SpriteDoc, post: ArcadePost) => {
          const dirty = history.canUndo || history.canRedo || docHasPixels();
          const proceed = dirty
            ? confirmModal({
                title: 'remix this sprite',
                body: `open '${post.title}' by ${post.handle}? your current sprite will be discarded.`,
                confirmLabel: 'remix',
                danger: true,
              })
            : Promise.resolve(true);
          void proceed.then((ok) => {
            if (!ok) return; // declined = no adoption, no lineage
            adopt(remixDoc); // clears the seam via adopt()'s first line…
            setRemixParent(post); // …then seeds it for the next publish
            status(`remixing '${post.title}' — post it back when it's yours`);
          });
        },
      });
    });
    addAction('sl-act-theme', 'theme', toggleTheme);

    this.teardown.push(installDragDrop(openImage, adopt, status));
    // System-clipboard paste imports like drag-drop — but an in-app pixel copy
    // owns cmd+v (the editor.paste() shortcut fires on the same keystroke; a
    // stale OS screenshot must never clobber a deliberate internal paste).
    this.teardown.push(installPaste(
      (img) => { if (!editor.hasClipboard) openImage(img); },
      (next) => { if (!editor.hasClipboard) adopt(next); },
      status,
    ));

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

    bus.emit('status:message', { text: welcomeLine() });
    if (firstRun) this.teardown.push(mountFirstRunCard(() => {}));
    this.teardown.push(closeAllModals);
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const dispose of this.teardown.splice(0).reverse()) dispose();
  }
}
