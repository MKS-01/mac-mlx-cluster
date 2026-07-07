# Agent instructions (mac-mlx-cluster)

Docs + tooling repo for MLX LLMs on a two-Mac Apple Silicon cluster. Guides live in `doc/` (`ARCHITECTURE.md` is the system reference), code in `src/`.

## Layout

- `src/tools/mlxctl` — Python model manager (stdlib only, no build/test, lint with `ruff check src/tools`). Edit the file here; a symlink in `~/.venvs/mlx/bin` picks it up.
- `src/tools/chat.py` — zero-dep Python chat client.
- `src/cli/` — Bun/TypeScript/Ink chat client. Verify with `cd src/cli && bun run build`. For non-trivial changes read `doc/ARCHITECTURE.md` first. UI rules (`src/ui/`): colors only from `theme.ts` (BLUE = accent only) and severity coloring only via `colorScale.ts`'s `pressureColor`; text is `FG`/`DIM`, no new shades; components are named-export Ink function components (`Box`/`Text` only) in `src/ui/components/`, wired together only in `app.tsx`; if a change alters how many lines a header/panel renders per frame, update the matching line-budget constant in `app.tsx` (`HEADER_LINES`, `PANEL_FIXED_LINES`, …) in the same change — Ink has no scroll region, a mismatch silently pushes UI off-screen. Config values reach SSH/shell argv — new config fields need regex validation in `src/config/config.ts` and a matching `config.example.json` entry. Everything binds to the Thunderbolt bridge IPs or `127.0.0.1`, never `0.0.0.0`. Any server a session starts must be stopped on every exit path. Never write `~/.mlx/cluster-cli-prefs.json` by hand — the CLI owns it.
- `doc/` — update the relevant guide when you change behavior.

## Rules

- This repo will be open-sourced: never commit secrets, API keys, or personal absolute paths.
- MLX lives in `~/.venvs/mlx` (not in this repo); models in `~/.cache/huggingface/hub`.
- Never `Ctrl+C` / kill an `hf download` — it can't resume. Only one download at a time.
- Prefer small, surgical diffs; match the style of surrounding code.

## Work loop (required)

After you believe a task is complete:
1. Invoke the `evaluator` subagent with the original task description.
2. If it returns `VERDICT: FAIL`, fix the listed defects and invoke it again.
3. Stop after 3 rounds either way and report the final verdict honestly — including any defects still open.
