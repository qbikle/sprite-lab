# sprite-lab

**Live: [sprite-lab.qbikle.workers.dev](https://sprite-lab.qbikle.workers.dev)** — installable PWA, works offline.

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

## Today (Waves 1–10)

- Crisp, dpr-aware canvas — scroll pans, ctrl/cmd+scroll zooms to cursor (25%–6400%), dark + light themes, keyboard-first (`?`)
- New-sprite modal (size presets, custom up to 512, palette source, background) + canvas resize with a 9-point anchor — click the size in the statusbar
- Paste an image from the clipboard (⌘V) to import it, drag-drop still works
- Tools: pencil / eraser / eyedropper / fill (selection-aware, symmetry-seeded), line / rect / ellipse with live preview, Bayer dither brushes, x/y/quad mirror, tiling preview
- Selection: rect marquee + lasso, move-float lifecycle, cut/copy/paste — all undoable
- Animation: timeline with per-frame durations, playback with tag ranges (loop/pingpong/hold), onion skin, drag-reorder frames
- Layers: opacity, visibility, rename, reorder, merge-down
- Color engine: a real HSV color picker (alpha, eyedropper), coat-swap (remap colors across every frame in one undo step), palette edit mode, ramps with a step control, .gpl import/export (incl. Aseprite RGBA)
- Export modal: pick a format card, see exactly which files you get, scale 1×–100× (a 32px sprite exports razor-sharp at 3200px)
- Live preview panel (always looping, tag-aware) + flip/rotate canvas ops
- Sheets & IO: sprite-sheet labeler (rows → named tags), sheet+JSON repack, lossless GIF and animated WebP export (worker-encoded), px() char-map export, .sprite project files, dual-store autosave (OPFS + localStorage, newer-wins)
- Hand-drawn 44-glyph icon set on one 16×16 grid, focus-visible everywhere
- Touch & Apple Pencil: pinch/pan gestures, palm rejection, pressure→brush (`p`)
- Installable PWA — works fully offline; first run opens mochi, the demo cat
- Command-pattern undo/redo across EVERYTHING, byte-budgeted history panel
- 311 unit + 51 e2e tests, ~46 kB gzipped, zero runtime dependencies

## Where it's going

See [`docs/ROADMAP.md`](docs/ROADMAP.md) — all eight waves shipped, hosted on
Cloudflare Workers (auto-deploys from `main`; bump `public/sw.js` VERSION per release).

Architecture (frozen contracts, module map): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Legacy

The original single-file tool ([`legacy/sprite-lab-v1.html`](legacy/sprite-lab-v1.html)) is
retired as of Wave 5 — v2 covers everything it did. Kept as a historical reference.
