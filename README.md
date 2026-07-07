# sprite-lab

A zero-dependency, single-file web tool for working with sprite sheets: label
animation rows, preview them at real speed, and pixel-edit frames in place.

Born as a side-tool while building [mOS](https://github.com/qbikle/mOS-portfolio)'s
desktop cat — grew a full editor, now it's its own thing.

## Run

```bash
# any static server from a directory containing a sheet.png
python3 -m http.server 8787
# open http://localhost:8787
```

Drop your own `sheet.png` next to `index.html` (any dimensions; set frame w/h
in the toolbar and hit rebuild).

## What it does today

- **Auto-slicing**: detects frames per row via alpha scan (variable counts fine)
- **Label & tune**: name each row, per-row fps override, include/exclude frames
- **Live previews**: every row animates at real speed, zoom 2–8x
- **Pixel editor**: click any frame — pencil/eraser/fill/eyedropper, nudge,
  h-flip, onion skin (prev red / next teal), frame copy/paste, 200-step
  undo/redo across frames, live row playback while you paint
- **Palette**: auto-extracted from the sheet + custom colors
- **Persistence**: edits autosave to localStorage; `download sheet.png`
  exports your edited sheet; `export json` emits the animation metadata
- One HTML file. No build, no deps.

## Where it's going

See [`docs/ROADMAP.md`](docs/ROADMAP.md).
