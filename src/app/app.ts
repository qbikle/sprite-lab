/** App — composition root: builds core/render/tools/ui/io and wires them via the bus. */
import { Bus } from '../core/bus';
import { History } from '../core/history';
import { SpriteDoc } from '../core/doc';
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
import { installDragDrop, openFilePicker } from '../io/import';
import { downloadBlob, exportPng } from '../io/exporters/png';
import { EditorState } from './editor';
import { Player } from './player';

const THEME_KEY = 'sprite-lab:v2:theme';

export class App {
  private readonly root: HTMLElement;
  private mounted = false;
  private readonly teardown: Array<() => void> = [];

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /**
   * Boot order: restore autosave (else blank 32×32) → core (doc/history/bus)
   * → editor+tools → shell → viewport → panels → shortcuts → autosave.start()
   * → topbar actions (new/open/export png/theme).
   */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    const doc = Autosave.restore() ?? SpriteDoc.blank(32, 32, 'untitled');
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
    let opacityDrag: { index: number; at: number } | null = null;

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
      // slider drags fire per input event — replace-last so a drag = one history entry
      setOpacity: (i, opacity) => {
        const now = performance.now();
        if (opacityDrag && opacityDrag.index === i && now - opacityDrag.at < 600 && history.canUndo) {
          history.undo();
        }
        history.commit(new SetLayerOpacity(i, opacity));
        opacityDrag = { index: i, at: now };
      },
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
    const setRangeFromTag = (index: number | null): void => {
      const tag = index === null ? undefined : editor.doc.tags[index];
      activeTag = tag ? index : null;
      player.setRange(tag ? { from: tag.from, to: tag.to, mode: tag.mode } : null);
    };

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
      removeTag: (index) => {
        history.commit(new RemoveTag(index));
        if (activeTag === null) return;
        if (index === activeTag) setRangeFromTag(null);
        else if (index < activeTag) activeTag -= 1;
      },
      updateTag: (index, next) => {
        history.commit(new UpdateTag(index, next));
        if (index === activeTag) {
          player.setRange({ from: next.from, to: next.to, mode: next.mode });
        }
      },
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
    addAction('sl-act-new', 'new', () => {
      if (history.canUndo && !window.confirm('Discard the current sprite?')) return;
      adopt(SpriteDoc.blank(32, 32, 'untitled'));
    });
    addAction('sl-act-open', 'open', () => openFilePicker(adopt));
    addAction('sl-act-export', 'export', () => {
      void exportPng(editor.doc, editor.activeFrame)
        .then((blob) => downloadBlob(blob, `${editor.doc.meta.name}.png`))
        .catch(() => bus.emit('status:message', { text: 'png export failed' }));
    });
    addAction('sl-act-theme', 'theme', toggleTheme);

    this.teardown.push(installDragDrop(adopt));

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
    shortcuts.register({ keys: '=', desc: 'zoom in', group: 'canvas', run: () => zoomAt(1) });
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

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const dispose of this.teardown.splice(0).reverse()) dispose();
  }
}
