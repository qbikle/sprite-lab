# sprite-lab — Claude session guide

Professional pixel-art + animation editor for the web. Cozy-retro UI, tool-grade ergonomics.
Vanilla TypeScript + Vite, **zero runtime dependencies**. Aim: the tool you reach for instead of Aseprite for pixel work.

## Start every session

1. Read `docs/ROADMAP.md` — wave status, session log, gotcha ledger.
2. Read `docs/ARCHITECTURE.md` — module map + frozen contracts.
3. Before ending a session: update ROADMAP status + append a session-log line + record new gotchas. **Never skip this.**

## Commands

```bash
npm run dev        # dev server on :5180 (user's port — never use for agent testing)
npm run build      # typecheck + production build
npm run typecheck  # tsc --noEmit
npm run test       # vitest — core model unit tests
npm run e2e        # playwright e2e (side ports 5199+)
```

## Conventions (non-negotiable)

- **Zero runtime deps.** devDependencies only: vite, typescript, vitest, playwright. Adding anything else needs an explicit user decision.
- **Strict TS.** No `any`, no `@ts-ignore`. `noUncheckedIndexedAccess` on — index access returns `T | undefined`, handle it.
- **OOP discipline:**
  - Tools are polymorphic classes over the frozen `Tool` contract — the editor never knows concrete tool types.
  - Every document mutation is a `Command` (apply/revert) through `History`. No direct doc writes outside commands.
  - Document model (`core/`) is DOM-free and renderer-agnostic. Rendering reads the doc; never the reverse.
  - `private`/`readonly` fields, minimal public surface per class.
- **Contracts frozen:** `src/core/contracts.ts` (types, event names, document JSON schema), CSS token *names* in `tokens.css`, keyboard defaults. Additive changes only, documented in ARCHITECTURE.
- **Styling:** var() tokens only — no hardcoded colors outside `tokens.css`. Dark AND light themes must both look intentional. AA contrast for text.
- **Pixel buffers:** `Uint32Array`, native little-endian ABGR (compatible with `new Uint32Array(imageData.data.buffer)`). Helpers in `core/pixels.ts` only — never hand-pack elsewhere.
- **Heavy encoding (gif/webp/sheet) runs in workers.** UI thread never blocks >16ms.
- **Cleanup:** every listener/timer/rAF is owned and disposed (`own()` pattern).
- **Persistence:** autosave is a scratch buffer, never the source of truth. Files in, files out.
- **No emoji in UI** — px-map glyphs / text labels. ASCII kaomoji ok in copy.

## Testing bar

- Core model changes ship with vitest coverage (commands must round-trip apply→revert).
- UI/visual changes ship with a Playwright pass on a **side port** (5199+, never :5180) + screenshot
  self-review, minimum 3 critique passes on anything visual.
- Waves gate on an end-to-end run: actually draw → animate → export a real sprite, verify the output file.

## Legacy

`legacy/sprite-lab-v1.html` is the original single-file tool, RETIRED at Wave 5 (v2 labeler
parity). Historical reference only — never extend it.
