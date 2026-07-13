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

## Today (Wave 1)

- Crisp, dpr-aware canvas — smooth pan/zoom (wheel = zoom-to-cursor, space/middle-drag = pan, pinch on touch), zoom stops 25%–6400%
- Pencil / eraser / eyedropper / fill (contiguous + global with ⇧), brush sizes 1–8
- Command-pattern undo/redo across everything, byte-budgeted history
- Color panel: palette swatches, hex input, recent colors, transparent erase-ink
- Dark + light themes (`T`), keyboard-first (`?` shows the cheat sheet)
- PNG import (picker + drag-drop) and export, localStorage autosave

## Where it's going

See [`docs/ROADMAP.md`](docs/ROADMAP.md) — waves: drawing kit (shapes, dither,
mirror, selection) → animation & layers → palette engine (coat-swap as a feature)
→ sheets & IO (labeler, GIF/WebP, project files) → ship (PWA, touch/pencil).

Architecture (frozen contracts, module map): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Legacy

The original single-file tool lives at [`legacy/sprite-lab-v1.html`](legacy/sprite-lab-v1.html)
(open beside a `sheet.png` via any static server) until v2 reaches labeler parity.
