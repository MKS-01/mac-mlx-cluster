# Architecture

System-level reference: what talks to what, where state lives, and why the
non-obvious decisions were made. For step-by-step setup, see
[`CLUSTER_SETUP.md`](./CLUSTER_SETUP.md); for single-Mac basics, see
[`MLX_QUICKSTART.md`](./MLX_QUICKSTART.md). The coding-agent harness that runs
against this stack is described in [`HARNESS.md`](./HARNESS.md).

## Hardware topology

Two Macs joined by a direct Thunderbolt cable (macOS's `bridge0` interface,
static IPs on top):

| Node | Role | Model | RAM | IP (bridge) |
|---|---|---|---|---|
| **m1** | server (always-on) | M1 Pro | 32 GB | `10.0.0.1` |
| **m5** | dev / peer | M5 Pro (faster) | 48 GB | `10.0.0.2` |

No Wi-Fi/LAN dependency for cluster traffic — everything (SSH, the model
API, macmon stats, distributed `mlx.launch` jobs) rides the Thunderbolt
bridge. RDMA/JACCL is the better-performing backend and would be the
default choice if both nodes supported it, but it needs Thunderbolt 5 on
*every* node — the M1 Pro here only has TB4, so this particular pair can't
reach it regardless of cable. Distributed jobs use the `ring` (TCP) backend
instead; see `CLUSTER_SETUP.md`'s "Backend choice" for the full tradeoff.

## Two serving patterns

**Pattern A — dedicated server (default, what's actually running).** The m1
runs `mlx_lm.server` as a LaunchAgent (`com.mlx-server`, offline-mode via
`HF_HUB_OFFLINE=1`), always on, bound to the bridge IP only. The m5 (or any
client) talks to it as a plain OpenAI-compatible REST API. No sharding — one
Mac holds the whole model, the other's memory stays 100% free.

**Pattern B — tensor-parallel sharding**, only for models too big for one
Mac (>~38 GB). Launched via `mlx.launch --backend ring` across both nodes —
either manually (`CLUSTER_SETUP.md` §7) or from inside the CLI via
`/mode cluster` (below).
Aggregates *memory*, not speed — sharding a model that already fits on one
Mac makes it slower, so Pattern A is preferred whenever the model fits.
**Uneven splits (60/40, 55/45) are not possible at the tensor-parallel
level** — ranks always get equal shares, model dims must divide by rank
count, and forcing an uneven split via multiple ranks per GPU caused Metal
timeouts on the M1 in testing. This is why the CLI's wear-leveling feature
(below) balances *which Mac serves whole*, not *how the model is split*.

## `src/tools/mlxctl` — model cache manager

Standalone Python script (no deps beyond `huggingface_hub`), symlinked into
`~/.venvs/mlx/bin`. Manages `~/.cache/huggingface/hub` with incomplete-aware
status (`hf cache list` only counts finished files; `mlxctl list`/`status`
also see in-progress downloads). This cache is shared and load-bearing:
both `mlx_lm.server` (offline mode) and the CLI's `/model` command treat
"what's in this cache" as the hard source of truth for what can be served.

Dev loop:

```sh
~/.venvs/mlx/bin/pip install -r src/tools/requirements.txt -r src/tools/requirements-dev.txt
ruff check src/tools/mlxctl      # lint
ruff format src/tools/mlxctl     # format
```

### Commands

| Command | What it does |
|---|---|
| `list` (`ls`) | Every cached repo, true on-disk size (via `real_size`, which sums resolved blobs including `.incomplete` temp files), and a complete/incomplete/partial/downloading status derived from `completeness()` — not from `hf cache list`, which only counts finished files. |
| `status` (`st`) `<repo>` | Per-shard detail for one repo: which files `model.safetensors.index.json`'s `weight_map` expects, which are actually present, and how many stale `.incomplete` blobs remain. |
| `download <repo>` | `os.execv`s straight into `hf download <repo>` (replaces the `mlxctl` process rather than wrapping it, so Ctrl+C semantics are `hf`'s own). Refuses to start if `downloading_pid()` (a `pgrep` on the `hf download` command line) already finds one running for that repo. |
| `remove` (`rm`) `<repo>` | Deletes the repo's entire cache directory and its lock dir. The only command that touches complete files — deliberately separate from `clean` so a stuck download can be cleared without risking a finished model. |
| `clean [repo]` | With a repo: kills any `hf download` for it, deletes only stale `.incomplete` blobs and the lock dir, leaves complete snapshot files untouched. Without one: global tidy — clears every stale lock file and lists which cached repos are still incomplete, without killing or deleting anything. |
| `run <repo> [args]` | `os.execv`s into `mlx_lm.chat --model <repo> [args]`; default args are `--max-tokens 2048` if none given. |
| `search <query>` | Lists `mlx-community` Hub repos matching `query` (needs `huggingface_hub`, imported lazily so the rest of `mlxctl` has no hard dependency on it). |
| `meminfo [repo]` | See below. |
| `server <start\|stop\|status>` | See below. |

Every command that takes a `<repo>` accepts a unique substring of an
already-cached repo (`resolve()`; e.g. `9b`, `3.6`) as well as the full
`org/name` id — an ambiguous substring lists every match and exits nonzero
rather than guessing.

### `mlxctl server` — one command, local or remote

`mlxctl server start|stop|status` controls the server node's `mlx_lm.server`
LaunchAgent without the caller needing to know whether they're already on
that Mac. It reads `~/.mlx/cluster-cli.json` (same file the CLI reads) for
the LaunchAgent's `plistPath`/`serviceLabel`, then decides local-vs-remote
by checking whether that plist path actually exists on the local
filesystem (`is_local` in `cmd_server`) — if it does, `launchctl` runs
locally; if not, the exact same `launchctl` command runs over SSH against
`server.ip`. This is the same plist-existence trick used to detect "am I
the server node" without hardcoding hostnames anywhere. `start` also
retries as `launchctl kickstart -k` if the agent is already bootstrapped
(so it doubles as a restart), and `stop` treats "service not found" as
success rather than an error (idempotent either way).

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

### Config schema (`src/config/config.ts`, `src/config/prefs.ts`)

`ClusterConfig` has two `NodeConfig`-shaped entries — `server` (the
always-on Mac: adds `apiPort`, `plistPath`, `serviceLabel` on top of
`id`/`ip`/`sshUser`/`macmonPort`) and `peer` (stats-only, never SSH'd for
control) — plus `defaultModel`, `localApiPort` (for spawning
`mlx_lm.server` locally in fallback/solo mode), `venvPath`, and
`distributed.hostfile` (the `mlx.launch` hostfile path; rank 0's bind IP is
read from that file's first entry at launch time rather than duplicated in
config). `loadConfig()` merges the on-disk JSON over `DEFAULT_CONFIG` key
by key, so a config missing a field (or the whole file) silently gets the
default for just that field — the config-typo footgun called out above.

Every string field that ends up inside an SSH argv or a remote shell
command (`sshUser`, `ip`, `plistPath`, `serviceLabel`) is checked against a
permissive-but-bounded regex in `validateConfig()` before use. This isn't
schema validation for its own sake — it's the thing standing between a
typo'd or hostile `cluster-cli.json` and shell/SSH-option injection (e.g.
an `sshUser` starting with `-` being parsed as an `ssh` flag instead of
failing to connect). A field that fails the check throws `ConfigError`
naming the field, never a raw stack trace or a silently-run bad string.

`Prefs` (the other config file) is loaded even more defensively: any
missing or malformed field — one that isn't a plain string, isn't
`"combined"`/`"split"`, or is a `splitTarget`/`splitHistory` shape whose
numbers don't check out — falls back to its own default independently,
and a corrupt file overall falls back to `DEFAULTS` entirely rather than
crashing on load. Saving is similarly best-effort (`savePrefs` swallows
write errors) since prefs are a nicety, not load-bearing state.

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

Two corrections layered on the time-share policy (both in
`src/cluster/memory.ts` / `index.tsx`):

- **Memory-fit override** — the nodes are not interchangeable (32 vs
  48 GB), so whatever the split says, startup checks the model's cached
  size against the target node's estimated wired ceiling
  (`fitVerdict`, ~72% of RAM with mlx-lm's 90% warning margin — one shared
  definition also used by the `/model` list's fit column and the `/model`
  switch pre-flight) and serves from the other Mac instead if it can't
  wire, or suggests `/mode cluster` if neither can alone.
- **Shard crediting** — a sharded session works both Macs equally, so its
  active time is credited half to each node's history rather than lumped
  onto one side.

### Serving modes (`/mode`, `src/cluster/cluster.ts`, `src/net/distributed.ts`)

`/mode` switches how the model is served, mid-session, without restarting
the CLI. Three internal modes (`Mode` in `cluster.ts`):

- **`cluster`** (shown as **server** in the UI, reachable via `/mode
  server`) — Pattern A, attached to the server node's LaunchAgent (the
  startup default when it's reachable). Switching back to it discharges a
  prior takeover's restore-on-quit obligation — the LaunchAgent running
  again *is* the restoration, and the session re-attaches as shared infra
  rather than claiming ownership.
- **`local`** (shown as **solo** in the UI) — whole model served by a
  process this CLI spawned on this Mac. Reached three ways, distinguished
  by `localOrigin`: an emergency `"fallback"` (server unreachable at
  connect), or a deliberate `"takeover"` (wear-leveling turn, or the user
  typing `/mode solo`).
- **`shard`** (shown as **cluster** in the UI — the user-facing name for
  Pattern B) — `/mode cluster [<model>]` stops the server node's
  LaunchAgent (freeing its RAM), verifies the model is HF-cached on
  *every* node (no auto-copy — multi-GB transfers stay a deliberate step
  via the `model-transfer` skill), then spawns `mlx.launch --backend ring`
  running `mlx_lm.server` tensor-parallel across the hostfile's nodes.
  `mlx_lm.server` has native distributed support (rank 0 detects the group,
  loads via `sharded_load`, and serves the ordinary OpenAI-compatible HTTP
  API), so the CLI's chat/streaming code is unchanged — only process
  launch/teardown (`src/net/distributed.ts`) is new. Rank 0's IP is read
  from the hostfile itself (first entry, `mlx.launch`'s own convention),
  never duplicated in config. `/model` in this mode tears down and
  relaunches the whole distributed group (there's no plist to edit).

Mode switches tear down the old serving arrangement first
(`stopCurrentSession`) but do *not* restore Pattern A — only quitting does.
The restore-on-quit obligation (`tookOverFromServer`) carries forward
across switches, so however many `/mode` hops a session takes, quit still
brings the server node's LaunchAgent back exactly once. Teardown of a
sharded group also sweeps the server node for an orphaned `mlx_lm.server`
rank over SSH (whether `mlx.launch` reaps its remote rank on SIGTERM is
unverified on this hardware — the sweep is idempotent either way).

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

### Stats polling (`src/net/macmon.ts`)

Every 2s, `app.tsx` fetches `http://<host>:<macmonPort>/json` from
`macmon serve` (a separate always-running process on each Mac, outside
this repo) for both configured nodes, in parallel, with a 1.5s timeout —
`fetchNodeStats` never throws, an unreachable node just reports
`reachable: false` with an explanatory `error` string instead of taking
the stats bar down. `selfNodeId()` figures out which configured node
*this* process is running on by checking which configured IP (server's or
peer's) is bound to a local network interface; if the bridge is down and
neither is, it falls back to assuming the peer (the CLI's usual dev-Mac
convention). Whichever node resolves as "self" also gets a loopback retry
(`127.0.0.1:<port>`) if the bridge-IP fetch fails, so solo/fallback
sessions still show this Mac's own memory pressure without the bridge.
`combineStats()` reduces both nodes' snapshots into one figure (summed RAM,
averaged CPU%, max of each temperature) for `/stats`'s "combined" view;
`/stats` toggles to "split" for the same data shown per-node. Status-panel
color tiers (`src/ui/colorScale.ts`'s `pressureColor`) are a flat
green/yellow/red by pressure fraction (<60% / <85% / ≥85%), reused
identically for RAM and temperature so the panel doesn't invent a new
color language per metric.

### Rendering (`src/ui/app.tsx`, `src/chat/chatWindow.ts`, `src/ui/markdown.tsx`)

Ink has no real scroll region, so `<Static>` (which permanently flushes to
terminal scrollback) would push the header/stats panel off-screen as the
transcript grows. Instead the transcript is windowed to whatever fits the
terminal height — recomputed every render from `stdout.rows` minus fixed
line-budget constants (`HEADER_LINES`, `PANEL_FIXED_LINES`, `HELP_LINES`,
etc.) — so the header stays pinned and only the tail of history is shown
("↑ N earlier messages" when truncated).

That line budget depends on `chatWindow.ts`'s raw-text line-count estimate
staying accurate, which is why `markdown.tsx`'s renderer (headings,
`**bold**`, `` `code` ``, `-`/`*` bullets — the constructs local models
actually emit, nothing more) is deliberately restricted to *removing*
marker characters (`###`, `**`, backticks) and never adding wrapped
markup that could grow a line's rendered height past its raw-text
estimate. An unterminated marker mid-stream (a `**` with no closing pair
yet, since replies render incrementally as tokens arrive) falls through
as literal text rather than being guessed at, so a still-streaming reply
never flashes half-parsed formatting.

## Data flow summary

```
you ──▶ mlx-cluster-cli (wherever it runs)
          │
          ├─ decides: cluster (m1) or local (this Mac)?  [cluster.ts]
          ├─ decides: is it the peer's turn to serve?     [splitPolicy.ts]
          ├─ /mode cluster: shard across both Macs        [distributed.ts]
          │
          ▼
   mlx_lm.server (m1 LaunchAgent, spawned locally,
                  or one rank per Mac under mlx.launch)
          │
          ├─ HF cache (~/.cache/huggingface/hub, offline-only)
          └─ OpenAI-compatible REST + SSE, port 8080

   macmon serve (both Macs, port 9090) ──▶ stats bar + wear-leveling checks
```

## Repo layout

- `doc/` — this file plus the guides linked above.
- `src/tools/` — the Python side: `mlxctl` (cache manager), `dist_bench.py`
  (distributed smoke test + tensor-parallel benchmark, run under
  `mlx.launch`), `chat.py` (zero-dependency debugging/testing client for
  poking an `mlx_lm.server` endpoint — not a chat product, that's `src/cli/`
  below), the example configs (`hostfile.example.json`,
  `mlx-server.example.plist`, `wired-limit.example.plist`) referenced by
  `CLUSTER_SETUP.md`, and `requirements*.txt`.
- `src/cli/` — the TypeScript chat client described above, organized by
  domain under `src/cli/src/`: `config/` (static + dynamic config),
  `net/` (ssh/server/macmon — talking to the Macs), `cluster/` (mode
  decision + wear-leveling policy), `models/` (cache listing + `/model`
  switching), `chat/` (SSE streaming + transcript windowing), `ui/`
  (Ink `app.tsx`, theme, and `components/`). `index.tsx` is the entry point.
- `CLAUDE.md`, `README.md`, `LICENSE` — repo root.

## References

Primary sources for the platform behavior this project builds on top of —
useful when a design decision above needs re-checking against the
underlying API/OS contract rather than against this repo's own comments.

**Apple platform docs**

- [`MTLDevice.recommendedMaxWorkingSetSize`](https://developer.apple.com/documentation/metal/mtldevice/recommendedmaxworkingsetsize) —
  the Metal property `mx.device_info()`'s `max_recommended_working_set_size`
  mirrors; the "Wired-memory limit" section above is this value's macOS 15+
  `iogpu.wired_limit_mb` ceiling made visible.
- [Choosing a resource storage mode for Apple GPUs](https://developer.apple.com/documentation/metal/choosing-a-resource-storage-mode-for-apple-gpus) —
  why Apple Silicon's unified memory lets the CPU and GPU share one
  allocation with no copy, the property this whole cluster's memory-fit
  math (`fitVerdict`, `mlxctl meminfo`) ultimately rests on.
- [WWDC20: Explore the new system architecture of Apple silicon Macs](https://developer.apple.com/videos/play/wwdc2020/10686/) —
  background on the unified-memory SoC design referenced throughout
  `CLUSTER_SETUP.md` and this file's "Hardware topology" section.
- [Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) —
  the `launchd` model behind Pattern A's LaunchAgent (`com.mlx-server`,
  needs a logged-in GUI session) and the wired-limit LaunchDaemon
  (`CLUSTER_SETUP.md` §9, loads in the `system` domain instead, no GUI
  session required) — see also `man launchd.plist` locally for the full
  plist key reference used by `mlx-server.example.plist`/`wired-limit.example.plist`.
- [Use IP over Thunderbolt to connect Mac computers](https://support.apple.com/guide/mac-help/ip-thunderbolt-connect-mac-computers-mchld53dd2f5/mac) —
  Apple's own walkthrough for the `bridge0` Thunderbolt link (static IPs,
  no Wi-Fi/LAN dependency) that every SSH call, the model API, macmon
  polling, and `mlx.launch` traffic in this project rides over.

**MLX (Apple's ML framework — what everything here is actually running)**

- [MLX documentation](https://ml-explore.github.io/mlx/build/html/index.html) —
  the framework `mlx_lm.server`, `mlx.launch`, and every model in the HF
  cache run on.
- [`mlx.core.metal.device_info`](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.metal.device_info.html)
  and the [Metal API page](https://ml-explore.github.io/mlx/build/html/python/metal.html)
  (`set_wired_limit`, `set_memory_limit`, `set_cache_limit`) — the exact
  calls `mlxctl meminfo`'s `device_info()` subprocess and `mlx_lm`'s own
  automatic per-generation wiring (see "Wired-memory limit" above) are
  built on.
- [Unified Memory — MLX documentation](https://ml-explore.github.io/mlx/build/html/usage/unified_memory.html) —
  MLX's own lazy-evaluation memory model layered on top of the OS-level
  unified memory this file's "Hardware topology" section describes.
