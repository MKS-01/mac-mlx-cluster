---
name: design-system
description: Use when adding, editing, or reviewing UI in src/cli (Ink components, colors, panels, layout) to keep it consistent with the CLI's existing minimal terminal palette and rendering model. Triggers on new files under src/cli/src/ui/components, hardcoded hex/ANSI color codes outside theme.ts, or changes to app.tsx's line-budget constants.
---

The CLI's whole "design system" is two small files — there is no separate
tokens package, and it should stay that way (`src/cli/src/ui/theme.ts` says
so explicitly: "kept as a small constant copy, not a shared package: this
repo is standalone").

## Source of truth

- **`src/cli/src/ui/theme.ts`** — the only place color hex values may be
  defined: `FG`, `DIM`, `RED`, `BLUE`, `GREEN`, `YELLOW`. `BLUE` is the sole
  accent color (used for the CLUSTER wordmark, `/model`-style command
  hints, version string) — never repurpose it as a status color.
- **`src/cli/src/ui/colorScale.ts`** — the only place that maps a
  continuous value to a color: `pressureColor(pct)` gives
  green (`<0.6`) / yellow (`<0.85`) / red (`>=0.85`) for CPU/GPU/RAM
  pressure. Any new "gradient by severity" UI should extend or reuse this
  function, not invent a second threshold scheme.

## Rules when touching `src/cli/src/ui/`

1. **Never hardcode a hex or ANSI color in a component.** Import from
   `../theme` (or `../../theme` one level deeper under `components/`).
   Grep for stray hex literals before finishing:
   ```sh
   grep -rnE '#[0-9a-fA-F]{6}' src/cli/src/ui/components/ | grep -v '/theme.ts'
   ```
2. **Status/pressure coloring goes through `pressureColor`**, not a new
   inline `if (pct > ...) return "..."` — see `StatsBar.tsx` for the
   existing usage.
3. **Components are function components, named exports, Ink `Box`/`Text`
   primitives only** — no other rendering library, no default exports
   (check any existing file in `components/` for the pattern before adding
   one).
4. **Don't touch the line-budget constants in `app.tsx`**
   (`HEADER_LINES`, `PANEL_FIXED_LINES`, `HELP_LINES`, etc.) without first
   reading the "Rendering" section of `doc/ARCHITECTURE.md` — Ink has no
   scroll region, so the transcript window is sized by subtracting these
   constants from `stdout.rows` every render. Adding a line to `Header` or
   `StatusPanel` without updating the matching constant makes the
   header/stats panel silently scroll off-screen instead of erroring.
5. **New status text** (a new state the CLI can be in) should reuse
   `DIM` for secondary/help text and `FG` for primary text, matching every
   existing component — don't introduce a new "muted" shade.

## Checklist for a new component

- [ ] Colors only from `theme.ts` / `colorScale.ts`
- [ ] Lives in `src/cli/src/ui/components/`, imported by `app.tsx` (the
      only place components are wired together)
- [ ] If it renders every frame (like `StatsBar`), check whether it adds
      lines that need accounting for in `app.tsx`'s line budget
- [ ] Matches existing prop-typing style (inline `{ prop: type }`, no
      separate `Props` interface unless the component already has one)
