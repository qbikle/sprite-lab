# sprite-lab

A cozy-retro, professional pixel-art & animation editor for the web. Zero runtime
dependencies, strict TypeScript, files in — files out.

Born as a single-file side-tool while building [mOS](https://github.com/qbikle/mOS-portfolio)'s
desktop cat; now growing into the tool you reach for instead of Aseprite for pixel work.

## Run

```bash
npm install
npm run dev        # http://localhost:5180
```

```bash
npm run build      # typecheck + production build
npm run test       # vitest unit suite (core model)
npm run e2e        # playwright end-to-end (side port 5199)
```

## Today (Waves 1–5)

- Crisp, dpr-aware canvas — smooth pan/zoom, zoom stops 25%–6400%, dark + light themes, keyboard-first (`?`)
- Tools: pencil / eraser / eyedropper / fill, line / rect / ellipse with live preview, Bayer dither brushes, x/y/quad mirror, tiling preview
- Selection: rect marquee + lasso, move-float lifecycle, cut/copy/paste — all undoable
- Animation: timeline with per-frame durations, playback with tag ranges (loop/pingpong/hold), onion skin, drag-reorder frames
- Layers: opacity, visibility, rename, reorder, merge-down
- Color engine: coat-swap (remap colors across every frame in one undo step), palette edit mode, ramps, .gpl import/export
- Sheets & IO: sprite-sheet labeler (rows → named tags), sheet+JSON repack, GIF and animated WebP export (worker-encoded), px() char-map export, .sprite project files, OPFS autosave
- Command-pattern undo/redo across EVERYTHING, byte-budgeted history panel

## Where it's going

See [`docs/ROADMAP.md`](docs/ROADMAP.md) — one wave left: ship (touch/pencil,
PWA offline, hosting, onboarding).

Architecture (frozen contracts, module map): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Legacy

The original single-file tool ([`legacy/sprite-lab-v1.html`](legacy/sprite-lab-v1.html)) is
retired as of Wave 5 — v2 covers everything it did. Kept as a historical reference.
