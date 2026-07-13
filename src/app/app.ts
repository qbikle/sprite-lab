/** App — composition root: builds core/render/tools/ui/io and wires them via the bus. */
import { Bus } from '../core/bus';
import { History } from '../core/history';
import { SpriteDoc } from '../core/doc';
import { AddPaletteColor } from '../core/commands/palette-ops';
import { Camera } from '../render/camera';
import { Compositor } from '../render/compositor';
import { Viewport } from '../render/viewport';
import { PencilTool } from '../tools/pencil';
import { EraserTool } from '../tools/eraser';
import { EyedropperTool } from '../tools/eyedropper';
import { FillTool } from '../tools/fill';
import { Shell } from '../ui/shell';
import { Shortcuts } from '../ui/shortcuts';
import { ToolbarPanel } from '../ui/panels/toolbar';
import { ColorPanel } from '../ui/panels/color';
import { StatusBar } from '../ui/panels/status';
import { Autosave } from '../io/autosave';
import { installDragDrop, openFilePicker } from '../io/import';
import { downloadBlob, exportPng } from '../io/exporters/png';
import { EditorState } from './editor';

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
    const tools = [new PencilTool(), new EraserTool(), new EyedropperTool(), new FillTool()];
    const editor = new EditorState(doc, history, bus, tools);
    this.teardown.push(() => editor.dispose());

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

    const toolbar = new ToolbarPanel({
      host: slots.toolbar,
      bus,
      tools,
      getActive: () => editor.activeToolId,
      onSelect: (id) => editor.setTool(id),
      getBrush: () => editor.brushSize,
      onBrush: (size) => editor.setBrush(size),
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
    });
    colorPanel.mount();
    this.teardown.push(() => colorPanel.unmount());

    const statusBar = new StatusBar({
      host: slots.status,
      bus,
      getZoom: () => camera.zoom,
      getDocSize: () => ({ w: editor.doc.width, h: editor.doc.height }),
    });
    statusBar.mount();
    this.teardown.push(() => statusBar.unmount());

    const adopt = (next: SpriteDoc): void => {
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
    shortcuts.register({ keys: 't', desc: 'toggle theme', group: 'app', run: toggleTheme });
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
