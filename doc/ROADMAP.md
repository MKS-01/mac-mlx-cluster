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

## `CLUSTER_SETUP.md` §9 — verify wired-memory limit persistence on real hardware

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
