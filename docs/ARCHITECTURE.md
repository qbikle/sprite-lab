# sprite-lab v2 — Architecture

Vanilla TS + Vite, zero runtime deps. Document model ⟂ rendering ⟂ UI. Everything below the
"Frozen contracts" line is additive-only once shipped.

## Module map

```
src/
  main.ts                 boot: theme, app shell, session restore
  core/                   DOM-FREE. The document + mutation machinery.
    contracts.ts          ★ FROZEN — public types, event map, doc JSON schema
    pixels.ts             Uint32Array buffer ops (pack/unpack, blit, fill, flip, shift)
    doc.ts                Document: layers, frames, cels, palette, tags
    history.ts            Command history: apply/revert, byte-budgeted, transactions
    commands/             one file per command family (pixels, frames, layers, palette, tags)
    selection.ts          mask (Uint8Array) + bounds + float buffer model
    bus.ts                typed event emitter (mirror of mOS bus)
  tools/                  polymorphic Tool classes. One file per tool.
    tool.ts               abstract Tool + ToolCtx (the only doc access tools get)
    brush.ts              brush sizes + Bayer 2x2/4x4 dither stamping
    symmetry.ts           x/y/quad mirror point expansion
    pencil.ts eraser.ts eyedropper.ts fill.ts line.ts rect.ts ellipse.ts
    select-rect.ts lasso.ts move.ts
  render/                 reads doc, draws screen. Never mutates doc.
    camera.ts             pan/zoom transform, zoom stops, screen↔pixel math
    compositor.ts         layer→frame composite caches, dirty-rect invalidation
    viewport.ts           main canvas: checker, composite blit, rAF-on-dirty
    overlays.ts           grid, cursor, selection ants, onion, symmetry axes, tiling 3×3
  ui/                     component classes, no framework.
    tokens.css            ★ token names frozen — dark + light themes
    shell.ts              layout: menubar / toolbar / panels / statusbar
    shortcuts.ts          central keymap registry + cheat-sheet overlay
    panels/               toolbar, color, layers, timeline, history, preview
  io/
    import.ts             PNG/file-picker/drag-drop, sheet detection
    slicer.ts             auto (alpha-scan) + manual grid slicing
    labeler.ts            rows → named animations flow (v1 parity)
    project.ts            .sprite single-file save/load (JSON envelope, schema in contracts)
    autosave.ts           localStorage + OPFS scratch persistence
    pxmap.ts              px() char-map TS export (mOS icon pipeline)
    exporters/            png, sheet+json, gif, animated webp — via worker
    workers/encoder.worker.ts   transferable-based encode protocol
  app/
    editor.ts             EditorState: active tool/color/brush/frame/layer/selection
    app.ts                wiring: bus subscriptions, panels ↔ editor ↔ history
```

Ownership boundaries are per-file. Parallel agents each own disjoint files; `contracts.ts`
is read-only for everyone except an explicit contract-change task.

## Data model (frozen shape — see contracts.ts for source of truth)

```ts
type Rgba = number                      // packed u32, native-LE ABGR
interface Doc {
  version: 1
  width: number; height: number         // frame size, px
  layers: Layer[]                       // z-order, bottom → top
  frames: Frame[]                       // playback order
  cels: Record<`${LayerId}:${FrameId}`, Cel>   // sparse
  palette: Palette
  tags: Tag[]                           // named ranges: walk / run / sleep
  meta: { name: string }
}
interface Layer  { id: LayerId; name: string; opacity: number; visible: boolean }
interface Frame  { id: FrameId; durationMs: number }
interface Cel    { pixels: Uint32Array }      // width × height
interface Tag    { name: string; from: number; to: number; mode: 'loop'|'pingpong'|'hold' }
interface Palette { colors: Rgba[]; recent: Rgba[]; name: string }
```

- IDs are stable strings (`l1`, `f3`); reorder = array move, cel keys survive.
- One flat pixel format everywhere: `Uint32Array` little-endian ABGR — zero-copy views over
  `ImageData.data.buffer`. All packing via `core/pixels.ts`.

## Command pattern

```ts
interface Command {
  readonly label: string                // human, for history panel
  apply(doc: Doc): void
  revert(doc: Doc): void
  readonly dirty: DirtyScope            // cels+rects | frames | layers | palette | all
}
```

- Tools build ONE command per gesture (a stroke = one `PixelPatch` holding before/after
  subrect buffers per touched cel — memory ∝ dirty area, not frame size).
- Structural ops (merge layer, reverse frames) = transactions (composite commands).
- History budget is bytes (default 64 MB), not entry count.
- Everything undoable: draw, frames, layers, palette, tags, slicing.

## Tool contract

```ts
abstract class Tool {
  abstract readonly id: ToolId
  abstract readonly hotkey: string
  onDown(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void
  onMove(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void
  onUp(ctx: ToolCtx, p: PixelPt, e: PointerInfo): void
  onCancel(ctx: ToolCtx): void
  drawOverlay(g: OverlayCtx): void      // shape previews, marching ants
}
```

`ToolCtx` is the tool's entire world: read composite/cel pixels, stage preview writes to a
scratch buffer, `commit(command)`, selection mask, symmetry expansion, brush stamp. Tools
never touch the doc, the canvas, or the DOM directly.

## Rendering pipeline

1. `Compositor` keeps a per-frame composite cache (layers flattened, opacity applied);
   commands invalidate by dirty rect only.
2. `Viewport` redraws on rAF **only when dirty**: checkerboard → composite blit through
   `Camera` transform (snapped to device pixels, dpr-aware, `imageSmoothingEnabled=false`)
   → overlays.
3. Pan/zoom mutate only the camera — no recomposite — that's the 60fps guarantee.
4. Zoom stops: 0.25 0.5 1 2 3 4 6 8 12 16 24 32 48 64. Wheel = zoom-to-cursor;
   space-drag / middle-drag = pan; pinch on touch.
5. Onion skin renders tinted composite of ±N frames at configurable opacity, under the
   active frame. Tiling preview draws the composite 3×3 wrapped.

## IO

- **Import:** PNG drag-drop / picker. Sheets → `slicer` (alpha-scan auto grid, ported from
  v1, + manual w/h override) → frames. `labeler` preserves the v1 flow: rows → named tags,
  per-tag fps, exclude frames — exports the same JSON shape mOS consumes.
- **Export (worker):** single PNG, spritesheet PNG + JSON metadata, GIF (median-cut
  quantize + LZW, hand-rolled), animated WebP (per-frame `OffscreenCanvas.convertToBlob`
  webp encode + hand-rolled RIFF/ANMF mux — Chrome-family only, GIF is the fallback),
  `px()` char-map TS for the mOS icon pipeline.
- **Worker protocol:** request/response with transferables; UI shows progress, never blocks.
- **Project file:** `.sprite` = JSON envelope (doc schema + base64 cel buffers). Autosave
  mirrors to OPFS (localStorage fallback), restored on boot, but files are the truth.

## UI

- Component classes with `mount/unmount` + owned listeners (mOS `own()` pattern).
- `shortcuts.ts` is the single keymap: every tool on a key, `?` opens the cheat sheet.
- Panels talk to `EditorState` + bus only — no cross-panel imports.
- Themes: `tokens.css` dark (default) + light, switchable at runtime; token names frozen.
- Touch/pencil: Pointer Events end-to-end, pressure→brush hook, pinch zoom, two-finger pan.

## Frozen contracts (change = explicit, documented, additive)

- `src/core/contracts.ts` — Doc schema (versioned), Command, Tool, ToolCtx, EventMap,
  ToolId/LayerId/FrameId types, worker message types.
- Event names: `doc:changed`, `history:changed`, `tool:changed`, `frame:active`,
  `layer:active`, `selection:changed`, `palette:changed`, `playback:changed`, `theme:changed`.
- `tokens.css` custom-property names.
- Default keymap (see shortcuts.ts table).
- `.sprite` file schema + exported animation JSON shape (v1-compatible).

## Testing

- **vitest** on `core/` + `io/` pure parts: every command round-trips apply→revert to
  byte-identical buffers; slicer against fixture sheets; exporters against golden files.
- **playwright** e2e on side ports (5199+): real flows — draw, animate, export, reopen.
- Visual gate: screenshots reviewed before every commit, ≥3 self-critique passes.
- DEV hook: `window.__lab` ({ editor, history, camera, bus }) is exposed only under
  `import.meta.env.DEV` (stripped from prod builds) — e2e asserts doc state through it.

## Contract addenda (documented additions)

- `EventMap` gained `cursor:moved` (viewport → statusbar) beyond the original list.
- `StageBuffer` + `ViewportDelegate` live in contracts so render/ never imports app/.
- `EditorState.dispose()` releases its bus subscription (owned-listener rule); not part
  of the frozen surface, consumed by App teardown only.
- UI event contract: every writer of panel-visible state must emit its bus event —
  e.g. `viewport.setDocSize` emits `camera:changed` after refit.
- Wave 3 doc.ts additive helpers: `allocLayerId()`, `allocFrameId()`, `removeCel(key)`,
  `celEntriesForFrame(frameId)`, `celEntriesForLayer(layerId)` — for structural commands.
- `Compositor.frameCanvas` gained optional `float` param; `ghostCanvas(frame, tint, alpha)`
  returns a REUSED canvas (draw before requesting the next ghost).
- `playback:changed` has exactly one emitter: the Player. EditorState mirrors via
  `syncPlaying` (non-emitting); `OnionConfig` + `onion:changed` added to contracts.
