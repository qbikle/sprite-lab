# sprite-lab Roadmap

**Vision:** the fastest way on the web to go from "sprite sheet PNG" to
"labeled, previewed, hand-fixed, export-ready animations" — a focused tool
that respects pixel artists: no accounts, no cloud, no build step, files in
files out. Keep the single-file/zero-dep soul as long as feasible; if it ever
needs a build, it needs a reason.

## Status

| # | Phase | Scope | Status |
|---|-------|-------|--------|
| 0 | Origin | labeler + live previews + JSON export (built for mOS's cat) | ✅ |
| 1 | Editor | in-place pixel editor: tools, onion skin, undo, autosave, sheet export | ✅ |
| 2 | Files | open arbitrary sheets (file picker + drag-drop PNG onto the page), multiple sheets/tabs, project save/load (.spritelab.json bundling sheet + labels) | ⬜ |
| 3 | Editor v2 | selection (rect/lasso) + move/copy, line & rect tools, mirror-draw mode, resize/reorder/insert/delete rows & frames, per-frame canvas ops (rotate 90, shift-wrap) | ⬜ |
| 4 | Animation | proper timeline: per-frame durations (not just row fps), ping-pong/hold modes, side-by-side compare of two rows, ghost overlay of another row (align walk vs run) | ⬜ |
| 5 | Export | animated GIF + APNG + zip-of-frames export, spritesheet repack (change columns/padding), engine presets (Aseprite JSON, Godot, CSS steps() snippet) | ⬜ |
| 6 | Palette | palette panel: recolor-by-swap (the mochi coat trick as a feature), palette lock (drawing restricted to sheet colors), palette export (.gpl) | ⬜ |
| 7 | Ship | host it (static — GitHub Pages/Cloudflare), PWA offline, keyboard cheat-sheet overlay, onboarding demo sheet | ⬜ |

## Design principles

- **Files in, files out.** localStorage is a scratch buffer, never the source
  of truth. Everything exportable, nothing held hostage.
- **The sheet is the document.** No proprietary format as the primary artifact;
  .spritelab.json is a convenience wrapper around a PNG + metadata.
- **Fast to open, fast to fix.** Optimize for the "one broken frame" loop:
  open → spot → fix with onion skin → export. Under a minute.
- **Single file until it hurts.** Vanilla JS modules inside one HTML file;
  split only when a phase genuinely demands it (GIF encoding may).

## Known gotchas (carried from development)

- Author `display` on styled overlays defeats the UA `[hidden]` rule — always
  pair with an explicit `[hidden] { display: none }`.
- Canvas pointer→pixel math must correct for `clientLeft/Top` (border widths).
- localStorage is per-origin: two ports serving the same tool = two separate
  edit buffers. Feature-ify later (project files, phase 2) rather than fight it.
- Frame auto-detection is alpha-based: sheets with opaque backgrounds need a
  background-color keying option (fold into phase 2).

## Session log

| Date | Summary |
|------|---------|
| 2026-07-07 | Extracted from mOS (`tools/sprite-lab`) into a standalone repo. Current feature set: row labeling, alpha-scan frame detection, live previews, full pixel editor (tools/onion/undo/copy-paste), palette extraction, localStorage autosave, sheet + JSON export. Demo sheet: the mOS cat (15 rows). Roadmap drafted. |
