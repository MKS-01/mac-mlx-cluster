# Roadmap

Planned or considered work that isn't built yet. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the shipped pieces this
builds on actually work.

## `src/cli` — mid-session auto-divert for wear-leveling

**Status:** designed, not implemented. Parked in favor of keeping the
wear-leveling split simple (`/split 50/50`, checked once at CLI startup
only) for now.

**What it would add:** today, the wear-leveling split (`src/cluster/splitPolicy.ts`)
only decides which Mac should serve *at CLI startup*. If the m5 starts
running something else heavy partway through an already-running session,
nothing reacts — the CLI keeps serving from the m5 for the rest of that
session. This would make it react mid-session: if the m5 becomes
sustained-busy with something unrelated while a wear-leveling takeover
session (`session.tookOverFromServer`) is running, automatically migrate
serving back to the m1, without asking.

**Design summary** (full detail available if/when this gets picked up):
- Reuse the existing 2s stats-poll tick in `src/ui/app.tsx` (no new poller) —
  sample the peer's load only during idle gaps between chat exchanges
  (`!state.busy`), so the session's own inference load is never mistaken
  for "something else is busy."
- Require sustained busy-ness (proposed: 5 consecutive polls, ~10s) before
  triggering, not a single spike.
- Move the `IDLE_*`/`BUSY_*` thresholds (currently local to `index.tsx`)
  into `src/cluster/splitPolicy.ts` so both the startup check and this new mid-session
  check share one definition.
- Migration itself: `disconnect()` the current local session (stops the
  local server + restarts the m1's LaunchAgent, since `tookOverFromServer`
  is true) then `connect()` fresh to reattach to the m1 — mirroring the
  existing `/model` switch's `switching`-state UI pattern (disable input,
  show status notices) rather than anything new.
- Failure handling: if the m1 doesn't come back, `connect()` already falls
  back to local mode on its own (existing behavior) — the resulting session
  has `tookOverFromServer: false`, which naturally disarms further
  auto-divert attempts without extra bookkeeping. A cooldown is only
  needed for the rarer "local spawn itself is broken" case, where there's
  nothing left to serve from at all.
- Accounting fix required alongside this: active-generation time is
  currently credited in one lump to whichever mode was active at process
  exit. A migration splits that — the fix is to credit each `onActiveTime`
  delta to whatever mode is *current* at the moment it fires (sound because
  both migrations and `onActiveTime` calls only ever happen between
  exchanges, never concurrently), rather than instrumenting mid-exchange
  timestamps.
- Small optional add-on worth doing alongside it: `src/ui/components/StatusPanel.tsx`'s
  `serverLabel()` currently shows the same `"local fallback · spawned"`
  string for both a genuine "m1 unreachable" fallback and a deliberate
  wear-leveling takeover — worth distinguishing them in the UI once this
  logic exists, so a mid-session migration notice has visible context.
- Explicitly out of scope for this feature: a manual `/migrate` command
  (bidirectional, more surface area) and reacting to "the server node came
  back healthy" as an independent trigger (only "peer got busy" triggers a
  divert in this design) — both noted as separate potential follow-ups if
  wanted later.

**Open questions to settle before building:**
1. Sustained-busy duration (proposed 10s) and cooldown length after a
   failed migration (proposed 5 min) — both judgment calls, not derived
   from anything existing.
2. Whether "the m1 becoming reachable again" should also be an independent
   trigger to prefer moving back, or only "the peer got busy" as designed.
3. Go/no-go on the `StatusPanel` label distinction and the `/migrate`
   command, called out above as optional.

## `src/cli` — `/mode solo` / `/mode cluster`: verify on real hardware

**Status:** built (see `ARCHITECTURE.md` § "Serving modes"), but not yet
exercised on the actual two-Mac cluster — this repo has no test suite, so
the following can only be closed out live:

1. **Solo:** `/mode solo` mid-session → M1's LaunchAgent stops, local
   `mlx_lm.server` comes up, chat keeps working; quit restores the M1.
2. **Cluster smoke test:** `/mode cluster` with a model cached on both
   nodes → LaunchAgent stops first, `mlx.launch` group comes up, health
   check passes against rank 0's hostfile IP, streaming works, tok/s is in
   the ballpark of `CLUSTER_SETUP.md` §7's measured ~9.6 tok/s.
3. **Teardown:** leaving shard mode (or quitting) actually kills the remote
   rank. The code assumes the worst and always sweeps the server node with
   `pkill -f mlx_lm.server` over SSH after stopping `mlx.launch` — if the
   launcher turns out to reap its own remote rank on SIGTERM, the sweep is
   redundant (but harmless) and can stay.
4. **Cache-check failure path:** `/mode cluster <repo missing on one node>`
   → clear error naming the node, no partial launch, old session unharmed.
5. **`/model` inside shard mode:** old group fully down before the new one
   launches; **and** whether the 240s health-check budget in
   `src/cli/src/net/distributed.ts` matches real distributed cold-load
   timing (it's a guess — tune it once measured).
6. Whether a non-interactive `Bun.spawn` (stdin ignored) really sidesteps
   the "don't pipe stdin into `mlx.launch`" corruption gotcha.

## `src/cli` — harness visibility: show when another client is using the server

**Status:** shipped (2026-07-07). The stats poll in `src/ui/app.tsx` now
derives "another client is generating" from sustained GPU load (5
consecutive 2s ticks ≥ `BUSY_GPU_PCT`, thresholds shared with the startup
wear-leveling check via `src/cluster/splitPolicy.ts`) on the serving node
while this CLI is idle, rendered as a `· busy (another client)` suffix on
the StatusPanel `server` row. Motivated by `doc/HARNESS.md` — the OpenCode
harness and this CLI share one `mlx_lm.server`.

Remaining non-goal: per-request accounting (would need a metrics proxy in
front of `mlx_lm.server`; not worth it for a two-client setup).

## `src/cli` — startup & flags UX

**Status:** shipped (2026-07-07). `--version`/`-v`, `--local-port <port>`
(per-session override of `config.localApiPort` — the port-conflict error
had referenced this flag before it existed), attach-instead-of-refuse when
a healthy server already holds the local port (`cluster.ts
attachOrStartLocal`; such sessions refuse `/model` since the server isn't
theirs to restart), and a multi-line `--help`.

## `src/cli` — UI polish backlog (design-system pass)

**Status:** mostly shipped (2026-07-07): StatusPanel/ModelListView
truncation of long model names (a wrapped row silently broke the fixed
line budget), avg GPU% in the combined stats view, and a narrow-terminal
degrade (temps dropped below 80 columns).

Still open:

- **Resize debounce:** the `resize` listener in `src/index.tsx` wipes and
  repaints per event; rapid drag-resizes flicker. Cheap `setTimeout`
  coalesce, keeping the existing wipe-before-ink ordering. Deferred: the
  wipe ordering is correctness-critical (stale-frame pileup) and a TUI
  resize race is hard to verify non-interactively.
- **Startup duplicate-key warning (investigate):** a one-line React
  "Encountered two children with the same key" warning prints once at
  startup when macmon is unreachable on both nodes (the "stats
  unavailable" render path). Origin not yet pinned down — not obviously
  introduced by the 2026-07-07 UI changes; reproduce with both macmons
  stopped and bisect from there.

## Harness — allow agent use only in selected projects/paths

**Status:** shipped (2026-07-07). Option 2 below is built as
`src/tools/harness` (symlinked into `~/.venvs/mlx/bin` like `mlxctl`); see
`doc/HARNESS.md`'s "Gating which projects can run the agent" section.

**Goal:** the coding agent should only be able to operate inside an
explicit allowlist of project directories — running `opencode` anywhere
else (home directory, unrelated repos) should get no local providers and
no tools pointed at the machine.

**Design options, weakest to strongest:**

1. **Allowlist by construction (kept as the baseline):**
   don't put providers in `~/.config/opencode/opencode.json` — only
   projects that check in (or receive) an `opencode.json` with the
   `mlx-cluster`/`mlx-local` providers can use the harness at all.
   Selecting a project = copying the config there. Zero new machinery;
   the tradeoff is per-project copies to keep in sync.
2. **Wrapper with an explicit path allowlist (implemented):** the
   `src/tools/harness` launcher reads an allowlist file
   (`~/.mlx/harness-projects`, one absolute path per line, `#` comments
   allowed), refuses to start unless `pwd` is at or under one of them, and
   only then execs `opencode` with all args passed through.
   `harness allow [path]` / `harness deny <path>` / `harness list` manage
   the file. Enforces intent even if providers ever go global, and gives
   one obvious place to see every agent-enabled project.
3. **Belt-and-braces (combine 1+2, still open):** wrapper for the front
   door, plus OpenCode's own `permission` config per project to deny tools
   the project doesn't need (e.g. `webfetch` everywhere, `bash` in
   docs-only repos). Not built — the wrapper alone covers the stated goal;
   revisit if per-project tool scoping is wanted.

**Shipped as:** option 2 on top of option 1 (no global providers). The
wrapper is stdlib Python in this repo's existing tool style;
`doc/HARNESS.md`'s "other projects" flow is now `harness allow <path>`
then copy the config.

**Status:** tooling shipped (`mlxctl meminfo`, `wired-limit.example.plist`,
`CLUSTER_SETUP.md` §9, updated `debug`/`model-fit` skills) — see
`ARCHITECTURE.md`'s "Wired-memory limit" section for the design and why
it's shaped this way (MLX's own per-generation wiring vs. the OS-level
`iogpu.wired_limit_mb` ceiling this repo didn't previously surface at all).

Two things remain that need the actual M1 hardware, not just source
research, to close out:

1. **Confirm the LaunchDaemon actually loads without a GUI session.**
   `wired-limit.example.plist` is installed via
   `launchctl bootstrap system ...` (the `system` domain) specifically to
   avoid the existing LaunchAgent's "needs a logged-in GUI user" gotcha
   (`mlx-server.example.plist`, `CLUSTER_SETUP.md` §8) — but that's a
   design assumption, not yet verified against a fresh boot on the M1.
2. **Pick and set the real wired-limit value on the M1.** Run
   `mlxctl meminfo` there first to see its actual current
   `iogpu.wired_limit_mb` (don't assume a default), then choose a value
   comfortably above the largest model expected to run there and below
   its 32GB total, per `CLUSTER_SETUP.md` §9.
