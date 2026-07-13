# sprite-lab Roadmap

**Vision:** the pixel-art + animation editor you reach for instead of Aseprite for pixel
work on the web. Cozy-retro but professional — ergonomics beat theatre. No accounts, no
cloud, files in files out. Zero runtime deps, strict TS, real architecture
(see `ARCHITECTURE.md`).

The original 7-phase single-file plan (v1) is superseded by the wave plan below; v1 lives
on at `legacy/sprite-lab-v1.html` until Wave 5 reaches labeler parity.

## Waves

| # | Wave | Scope | Gate (must demo) | Status |
|---|------|-------|------------------|--------|
| 1 | Foundation | Vite+strict-TS scaffold, frozen contracts, doc model + command history, compositor/viewport (60fps pan/zoom, crisp at every zoom, dpr-aware), pencil/eraser/eyedropper/fill(contig+global), brush sizes, color panel v1 (swatches/hex/recent), dark+light themes, shortcuts+cheat-sheet, PNG import/export, localStorage autosave | draw + undo + export a sprite; zoom/pan smooth; both themes | ✅ |
| 2 | Drawing kit | line/rect/ellipse w/ preview, Bayer 2x2+4x4 dither brushes, x/y/quad mirror, tiling preview, select-rect/lasso/move-float + cut-copy-paste, history panel | tile-able mirrored sprite drawn with shapes; selection float+commit undoable | ⬜ |
| 3 | Animation & layers | timeline panel, frames + per-frame duration, playback w/ fps, reorder/duplicate/reverse, tags (walk/run/sleep, loop/pingpong/hold), onion skin past+future w/ depth+opacity, layer stack (opacity/visibility/merge, per-frame cels) | animate a multi-layer walk cycle with onion skin | ⬜ |
| 4 | Color engine | palettes create/save/import (.gpl+json), palette-swap engine (white-master → coat variants, first-class), color ramps, palette panel polish | regenerate a mochi coat variant via swap in <1 min | ⬜ |
| 5 | Sheets & IO | sheet import + auto/manual slicing, labeler flow (v1 parity: rows→tags→JSON), repack/export sheet+JSON, GIF + animated WebP export (workers), px() char-map export, .sprite project save/load, OPFS autosave | import v1 cat sheet → label → edit → export sheet+json+gif; v1 retired | ⬜ |
| 6 | Ship | touch/pencil (pinch/pan/pressure), perf pass, onboarding demo sheet, PWA offline, host (Pages), final polish | works on iPad w/ pencil; public URL | ⬜ |

Every wave: playwright e2e on side ports, screenshot gate (≥3 critique passes) before
commit, conventional cozy commit + push.

## Design principles

- **Files in, files out.** Autosave (localStorage/OPFS) is scratch, never the source of truth.
- **The document is honest.** `.sprite` is a convenience envelope over PNG-expressible pixels + JSON metadata; nothing held hostage.
- **Fast to open, fast to fix.** The "one broken frame" loop (open → spot → fix w/ onion → export) stays under a minute.
- **Ergonomics beat theatre.** Keyboard-first, 60fps always, crisp pixels at every zoom.

## Gotcha ledger

- Author `display` on styled overlays defeats the UA `[hidden]` rule — pair with explicit `[hidden] { display: none }`.
- Canvas pointer→pixel math must correct for `clientLeft/Top` (border widths).
- localStorage is per-origin: two ports = two edit buffers. Solved properly by project files (Wave 5).
- Frame auto-detection is alpha-based: opaque-background sheets need background-color keying (Wave 5 slicer option).
- Animated WebP encode relies on `OffscreenCanvas.convertToBlob('image/webp')` — Chrome-family only; Safari path falls back to GIF.
- `noUncheckedIndexedAccess` on: index access returns `T | undefined` — design APIs to avoid `!`.
- Inputs swallow single-key shortcuts (typing guard): any commit-on-Enter input MUST `blur()` after commit or the next hotkey dies in the input.
- Playwright pages default to `colorScheme: 'light'` — dark-theme screenshots need an explicit `colorScheme: 'dark'` context (main.ts falls back to `prefers-color-scheme`).
- Node ESM resolves imports from the *script file's* location, not cwd — throwaway scripts importing devDeps must live inside the repo.
- `ImageData` can legally wrap a shared `ArrayBuffer` → zero-copy composite upload (`putImageData` + dirty-rect args). Compositor relies on this.
- Every state that panels display must have a bus event fired from EVERY writer — `viewport.setDocSize` forgot `camera:changed` after refit and the statusbar zoom went stale.

## Session log

| Date | Summary |
|------|---------|
| 2026-07-07 | Extracted from mOS (`tools/sprite-lab`) into a standalone repo. v1 feature set: row labeling, alpha-scan frame detection, live previews, full pixel editor (tools/onion/undo/copy-paste), palette extraction, localStorage autosave, sheet + JSON export. Demo sheet: the mOS cat (15 rows). Old 7-phase roadmap drafted. |
| 2026-07-13 | v2 kickoff: architecture designed (doc model ⟂ rendering ⟂ UI, command-pattern history, polymorphic tools, worker encoders), wave plan replaces 7-phase plan, CLAUDE.md + ARCHITECTURE.md written. Awaiting plan nod → Wave 1. |
| 2026-07-13 | **Wave 1 shipped.** Contracts + stubs authored, then 5 parallel agents (core / render / tools / ui / io+wiring) filled bodies against frozen signatures — zero ownership collisions. 68 unit tests + 12 e2e green; visual gate ran 3 critique passes over 8 screenshots (both themes) and fixed: hex-input focus swallowing hotkeys, letter-monogram tool buttons → 12×12 px-map SVG icons, theme-blind grid color (now derives from `--text`), stale statusbar zoom after import/new, sticky cursor readout on pointerleave. DEV-only `window.__lab` hook powers e2e. Bundle: 15.9 kB gzip, zero runtime deps. |
