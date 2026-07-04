# mlx-cluster-cli — high-level plan (feasibility)

Status: **idea / not yet implemented.** This doc is a feasibility pass only —
architecture options and open questions, not a build spec.

## Prerequisites

**Everything this plan depends on is already set up** on both Macs — the
Thunderbolt cluster, the `mlx_lm.server` LaunchAgent, the default Qwen model,
and `macmon` (locally). See [`CLUSTER_SETUP.md`](./CLUSTER_SETUP.md) for the
verified state.

Any **mandatory setup commands or new requirements** this CLI project turns
out to need (e.g. `macmon` on the M1, a new LaunchAgent, a Bun/Ink project
scaffold) will be added here once implementation starts — none are known to
be missing yet, aside from the open items called out below.

## Goal

A terminal CLI (reusing the `readback` design system + stack) that manages the
two-Mac MLX cluster as a single tool:

- **Start on launch, stop on quit** — CLI start brings the model server up;
  `q` / quit tears it down. Same lifecycle pattern as `readback-cli` ↔
  `readback` server (spawn/health-check/SIGKILL-on-exit), just pointed at
  `mlx_lm.server` on the M1 instead of the readback FastAPI app.
- **Cluster-aware fallback** — if both Macs are reachable (Thunderbolt bridge
  up, SSH OK), use the two-Mac setup; if not, fall back to running the model
  **locally on whichever Mac the CLI is on**. No hard failure if the other
  node is asleep/unplugged/away.
- **Default model pre-set** — boots straight into the already-configured
  Qwen model (today: `mlx-community/Qwen3.6-35B-A3B-4bit-DWQ` on the M1
  server), zero-config for the common case.
- **Model switching** — a `/model` command (same shape as readback's) to
  swap the served model later, without restarting the CLI.
- **Chat is a first-class mode** — not just a monitoring dashboard. The CLI
  is a full chat client against the served model (streaming, multi-turn),
  built on the same request/response shape as the existing `src/cluster/chat.py`,
  just inside the Ink UI instead of a stdlib REPL.
- **Live system stats bar** — CPU, GPU/CPU temp, RAM usage at the top of the
  screen, both **combined** (cluster total) and **split per Mac**, plus total
  unified memory across both machines.

## Reusable stack (from `readback`)

| Piece | Reuse as-is? | Notes |
|---|---|---|
| Bun + TypeScript + Ink CLI shell | Yes | Same screen-reducer pattern (`input`/`busy`/`chat`/`quitting`), same resize-repaint fix, same standalone-binary build (`bun build --compile`). |
| Design system (`design-system/tokens`, Ghost palette, `theme.ts`) | Yes | Import the same tokens; this becomes a second consumer of the shared design system (arguably worth promoting `design-system/` to its own package if a third project shows up). |
| Server spawn/health-check/kill lifecycle (`src/cli/src/server.ts`) | Adapt | Same shape, different target: instead of spawning a local FastAPI process, it SSHes to start/stop the M1's `mlx_lm.server` LaunchAgent (`launchctl kickstart` / `bootout`) and health-checks `GET /v1/models` over the Thunderbolt bridge. |
| `/ws` protocol + FastAPI server | **No** — not needed | `mlx_lm.server` already speaks OpenAI-compatible REST + SSE streaming; no need to build a bespoke WebSocket server like readback's. The CLI talks directly to `mlx_lm.server`, the way `src/cluster/chat.py` already does. |
| Prefs persistence (`~/.config/.../cli.json`) | Yes | Same pattern for last-used model, split/combined stats view, chat history. |

**Net new work is small**: mostly an Ink UI (chat pane + stats bar + slash
commands) and a thin "cluster control" layer (SSH lifecycle + macmon
aggregation). No new server to write — `mlx_lm.server` is already the
backend.

## System stats: macmon

[`macmon`](https://github.com/vladkens/macmon) is already installed locally
and is the right tool:

```
macmon pipe -i 1000        # JSON snapshot per interval, one line per tick
macmon serve               # HTTP JSON at /json, Prometheus at /metrics
```

Sample fields (confirmed locally): `cpu_usage_pct`, `temp.cpu_temp_avg`,
`temp.gpu_temp_avg`, `memory.ram_total` / `memory.ram_usage`, per-core
`ecpu_usage`/`pcpu_usage`, `gpu_usage`. Everything the stats bar needs is
already in one JSON blob, sudoless.

**Two Macs → two sources of this JSON.** Options:
1. **`macmon serve` on both machines**, CLI polls both `http://<ip>:<port>/json`
   over the Thunderbolt bridge — no SSH round-trip per tick, clean HTTP,
   matches the existing "expose a small local HTTP service, poll it" pattern
   already used for `mlx_lm.server`. Needs `macmon` installed on the M1
   (unconfirmed — **open item**, see below) and another always-on LaunchAgent
   (same template shape as `mlx-server.example.plist`).
2. **SSH + `macmon pipe -s1` on demand**, no persistent process on the M1.
   Simpler to ship (no second LaunchAgent), slightly higher latency per tick
   (SSH round-trip), and one more thing that can hang if the link blips.

Combined/total figures are simple arithmetic once both JSON blobs are in
hand: sum `ram_usage`/`ram_total` for "total unified memory," average or
max the temps, etc. — no new metrics math, just aggregation in the UI layer.

## Cluster-aware fallback logic (sketch, not final)

```
on CLI start:
  ping/health-check the M1 (bridge IP, mlx_lm.server /v1/models)
  if reachable:
    mode = "cluster"   # M1 serves the model, M5 CLI is a pure client
  else:
    mode = "local"     # start mlx_lm.server on THIS Mac instead, same default model
  render stats bar for whichever node(s) are actually live
```

This mirrors the existing Pattern A design (`doc/CLUSTER_SETUP.md` §8) —
the CLI is really just a smarter front-end over "is the server up, if not
start one," extended to pick *which* Mac hosts it.

## Open questions / things to verify before implementing

- **Is `macmon` installed on the M1?** Not yet confirmed (last check was
  interrupted). If not, it's a one-line `brew install macmon` + optionally a
  LaunchAgent, same shape as the existing server template.
- **`macmon serve` vs `pipe` over SSH** — pick one (leaning `serve`, for
  parity with how `mlx_lm.server` is already exposed and polled).
- **Auth/exposure**: `macmon serve` binds like any local HTTP server — same
  "bridge-only bind" precedent as `mlx-server.example.plist` should apply so
  stats aren't exposed to Wi-Fi/LAN.
- **Where model-switch commands go**: does `/model` just change which repo
  `mlx_lm.server` is asked to load (needs a server restart under the new
  model — `mlx_lm.server` loads one model per process), or do we want a
  small local proxy that can hot-swap? Simplest first cut: `/model` triggers
  `launchctl kickstart -k` on the LaunchAgent with an updated `--model` arg
  in the plist — a few seconds of downtime per switch, acceptable for a
  personal tool.
- **Design system reuse boundary**: pull tokens in as a copy, a git submodule,
  or promote `design-system/` out of `readback` into its own small package
  that both projects depend on? Only worth deciding once this CLI is actually
  started.

## Non-goals for v1

- No web dashboard (unlike readback) — terminal-only, matches "just change
  the use case" framing.
- No new model-serving backend — `mlx_lm.server` stays authoritative;
  the CLI is a client + lifecycle manager, not a reimplementation.
- No multi-user / remote-outside-the-LAN access — this is a personal two-Mac
  tool, same trust boundary as the rest of `cluster/`.
