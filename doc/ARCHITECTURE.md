# Architecture

System-level reference: what talks to what, where state lives, and why the
non-obvious decisions were made. For step-by-step setup, see
[`CLUSTER_SETUP.md`](./CLUSTER_SETUP.md); for single-Mac basics, see
[`MLX_QUICKSTART.md`](./MLX_QUICKSTART.md).

## Hardware topology

Two Macs joined by a direct Thunderbolt cable (macOS's `bridge0` interface,
static IPs on top):

| Node | Role | Model | RAM | IP (bridge) |
|---|---|---|---|---|
| **m1** | server (always-on) | M1 Pro | 32 GB | `10.0.0.1` |
| **m5** | dev / peer | M5 Pro (faster) | 48 GB | `10.0.0.2` |

No Wi-Fi/LAN dependency for cluster traffic — everything (SSH, the model
API, macmon stats, distributed `mlx.launch` jobs) rides the Thunderbolt
bridge. RDMA/JACCL speedups need Thunderbolt 5, which the M1 Pro lacks, so
distributed jobs use the `ring` (TCP) backend instead.

## Two serving patterns

**Pattern A — dedicated server (default, what's actually running).** The m1
runs `mlx_lm.server` as a LaunchAgent (`com.mlx-server`, offline-mode via
`HF_HUB_OFFLINE=1`), always on, bound to the bridge IP only. The m5 (or any
client) talks to it as a plain OpenAI-compatible REST API. No sharding — one
Mac holds the whole model, the other's memory stays 100% free.

**Pattern B — tensor-parallel sharding**, only for models too big for one
Mac (>~38 GB). Launched via `mlx.launch --backend ring` across both nodes.
Aggregates *memory*, not speed — sharding a model that already fits on one
Mac makes it slower, so Pattern A is preferred whenever the model fits.
**Uneven splits (60/40, 55/45) are not possible at the tensor-parallel
level** — ranks always get equal shares, model dims must divide by rank
count, and forcing an uneven split via multiple ranks per GPU caused Metal
timeouts on the M1 in testing. This is why the CLI's wear-leveling feature
(below) balances *which Mac serves whole*, not *how the model is split*.

## `src/mlxctl` — model cache manager

Standalone Python script (no deps beyond `huggingface_hub`), symlinked into
`~/.venvs/mlx/bin`. Manages `~/.cache/huggingface/hub` with incomplete-aware
status (`hf cache list` only counts finished files; `mlxctl list`/`status`
also see in-progress downloads). This cache is shared and load-bearing:
both `mlx_lm.server` (offline mode) and the CLI's `/model` command treat
"what's in this cache" as the hard source of truth for what can be served.

### Wired-memory limit (`mlxctl meminfo`)

Two layers, easy to conflate:

- **Per-generation wiring is already automatic inside `mlx_lm`** — its
  `wired_limit()` context manager (in `mlx-lm`, not this repo) calls
  `mx.set_wired_limit(mx.device_info()["max_recommended_working_set_size"])`
  before every generation and restores the previous value after. Nothing
  in this repo needs to touch that.
- **The OS-level ceiling is what actually gates it**: `max_recommended_working_set_size`
  is itself capped by the macOS 15+ sysctl `iogpu.wired_limit_mb`, which
  resets on every reboot and was previously invisible anywhere in this
  repo. If a model is close to or past it, `mlx_lm.server`'s log
  (`~/Library/Logs/mlx-server.log`) shows
  `[WARNING] Generating with a model that requires ... This can be slow`
  and falls back to slower paged memory.

`mlxctl meminfo [repo]` surfaces both layers on whichever Mac it's run on:
total RAM and `max_recommended_working_set_size` (from `mx.device_info()`,
via a one-shot subprocess into the venv's Python — `mlxctl` itself has no
hard MLX dependency), the live `iogpu.wired_limit_mb`, and — given a cached
repo — a fits/near-ceiling/exceeds verdict using the same 90%-of-ceiling
threshold `mlx-lm` warns at internally. `doc/CLUSTER_SETUP.md` §9 covers
raising and persisting the sysctl (`wired-limit.example.plist`, a
LaunchDaemon rather than the server's LaunchAgent, so it doesn't need a
logged-in GUI session to load).

## `src/cli` — mlx-cluster-cli

Bun + TypeScript + Ink terminal client. Fully standalone (own
`package.json`/lockfile), no monorepo tooling ties it to the Python side.
Two config files, both under `~/.mlx/` (outside the repo):

- **`cluster-cli.json`** — static topology (`server`/`peer` node configs:
  IPs, SSH users, ports, the LaunchAgent's plist path/service label),
  default model, local venv path. Copy from `src/cli/config.example.json`.
  Missing file silently falls back to hardcoded defaults — a typo here can
  look like it worked while quietly talking to the wrong IPs.
- **`cluster-cli-prefs.json`** — dynamic state the CLI writes itself: last
  model used, stats view (combined/split), and the wear-leveling split
  target + accumulated history (below).

### Mode decision (`src/cluster/cluster.ts:connect`)

On launch: HTTP-check the m1 → if down, SSH in and bootstrap/kickstart its
LaunchAgent → if that also fails (bridge down, m1 asleep), spawn
`mlx_lm.server` locally on whichever Mac the CLI is actually running on
("local mode"). Tracks whether *this session* started the m1's server
(`ClusterOrigin: "started"` vs `"attached"`) so quit only tears down infra
it created — Pattern A's server is meant to stay always-on shared
infrastructure that an ordinary session never assumes ownership of.

### Wear-leveling split (`src/cluster/splitPolicy.ts`, `src/cluster/cluster.ts:connectPreferPeer`)

Because uneven tensor-parallel splits don't work (see Pattern B above), load
balancing between the two Macs happens at the *whole-session* level instead:
`/split 60/40` sets a target time-share of **active generation time**
(request-to-response wall time, not idle time between messages — the m5 is
faster, so equal wall-clock time would actually be unequal wear).

At startup, if accumulated history says it's the peer's (m5's) turn:
1. Check the m5's own live CPU/GPU load via macmon first.
2. **Idle** → switch silently: stop the m1's LaunchAgent (so it actually
   rests, not just sits loaded-but-idle) and serve locally on the m5 instead.
3. **Already busy with something unrelated** → skip switching, stay on the
   m1, no prompt.
4. **Ambiguous load** → ask for confirmation.

Whichever Mac took over restores the other's LaunchAgent on quit
(`tookOverFromServer` flag), including on a crash (`bootstrapRemoteSync` in
the process-exit handler) — Pattern A's always-on invariant holds again
once the session ends.

### `/model` switching (`src/models/models.ts`, `src/models/switchModel.ts`)

Lists/resolves against the HF cache actually present on the *serving* node
(`du` over SSH in cluster mode, local `du` in local mode) — never a static
list — because the server runs offline-only, so switching to an uncached
repo would just break on restart. Cluster mode edits the remote LaunchAgent
plist (`src/net/ssh.ts:setRemoteModel`, via a small inline Python/`plistlib` script
to avoid hand-editing XML) and `launchctl kickstart`s it; local mode kills
and respawns the CLI's own process.

### Chat streaming (`src/chat/chat.ts`)

Talks to `mlx_lm.server`'s OpenAI-compatible SSE endpoint. Reasoning models
(Qwen3.6's thinking mode) stream internal reasoning under a separate
`delta.reasoning` field from the actual `delta.content` — both count against
`max_tokens` server-side, so a verbose thinking pass can exhaust the whole
budget before any real content is emitted. The client detects this
(`finish_reason: "length"` with zero content chunks) and surfaces a clear
error instead of silently rendering an empty reply.

### Rendering (`src/ui/app.tsx`, `src/chat/chatWindow.ts`)

Ink has no real scroll region, so `<Static>` (which permanently flushes to
terminal scrollback) would push the header/stats panel off-screen as the
transcript grows. Instead the transcript is windowed to whatever fits the
terminal height — recomputed every render from `stdout.rows` minus fixed
line-budget constants (`HEADER_LINES`, `PANEL_FIXED_LINES`, `HELP_LINES`,
etc.) — so the header stays pinned and only the tail of history is shown
("↑ N earlier messages" when truncated).

## Data flow summary

```
you ──▶ mlx-cluster-cli (wherever it runs)
          │
          ├─ decides: cluster (m1) or local (this Mac)?  [cluster.ts]
          ├─ decides: is it the peer's turn to serve?     [splitPolicy.ts]
          │
          ▼
   mlx_lm.server (m1 LaunchAgent, or spawned locally)
          │
          ├─ HF cache (~/.cache/huggingface/hub, offline-only)
          └─ OpenAI-compatible REST + SSE, port 8080

   macmon serve (both Macs, port 9090) ──▶ stats bar + wear-leveling checks
```

## Repo layout

- `doc/` — this file plus the guides linked above.
- `src/mlxctl`, `src/requirements*.txt` — Python cache-management tool.
- `src/cluster/` — distributed-MLX smoke-test scripts and example configs
  (hostfile, LaunchAgent plist) referenced by `CLUSTER_SETUP.md`.
- `src/cli/` — the TypeScript chat client described above, organized by
  domain under `src/cli/src/`: `config/` (static + dynamic config),
  `net/` (ssh/server/macmon — talking to the Macs), `cluster/` (mode
  decision + wear-leveling policy — unrelated to the Python `src/cluster/`
  above despite the shared name), `models/` (cache listing + `/model`
  switching), `chat/` (SSE streaming + transcript windowing), `ui/`
  (Ink `app.tsx`, theme, and `components/`). `index.tsx` is the entry point.
- `CLAUDE.md`, `README.md`, `LICENSE` — repo root.
