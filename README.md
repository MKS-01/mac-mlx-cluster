<div align="center">

# mac-mlx-cluster

**Two Macs. One Thunderbolt cable. Zero cloud.**

Run LLMs on Apple Silicon with [MLX](https://github.com/ml-explore/mlx) — solo on
one Mac, or pooled across two for models neither can hold alone.

[![License: MIT](https://img.shields.io/badge/License-MIT-orange?style=flat-square&labelColor=000000)](./LICENSE)
![Platform: Apple Silicon](https://img.shields.io/badge/Platform-Apple%20Silicon-orange?style=flat-square&labelColor=000000&logo=apple&logoColor=white)
![Python: 3.12+](https://img.shields.io/badge/Python-3.12%2B-orange?style=flat-square&labelColor=000000&logo=python&logoColor=white)
[![Powered by MLX](https://img.shields.io/badge/Powered%20by-MLX-orange?style=flat-square&labelColor=000000)](https://github.com/ml-explore/mlx)

<!-- Real screenshot: save as doc/img/cli.png and change the src below -->
<img src="./doc/img/cli.svg" alt="mlx-cluster — live memory bars, model switching, and serving-mode control in one terminal session" width="720">

</div>

## Why this exists

A weekend 1–3 AM side project, built after watching
[WWDC 2026 session 233](https://developer.apple.com/videos/play/wwdc2026/233/)
to see if my aging M1 Pro could pull its weight next to a newer Mac.
[exo](https://github.com/exo-explore/exo) proved it possible, but its
auto-discovery and web dashboard are overkill for two Macs whose IPs I
already know — `mlx.launch` does the same job MLX-native with a fraction
of the moving parts, wrapped here in a proper terminal CLI. It then kept
growing: once the models were being served anyway, the obvious next step
was pointing coding agents at them — first an external OpenCode harness,
then an agent built into the chat client itself. Every command in
[`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md) was run for real,
failures included — that's where the gotchas sections come from.

```
   ┌──────────────────────┐                          ┌──────────────────────┐
   │   M5 Pro · 48 GB     │      Thunderbolt 4       │   M1 Pro · 32 GB     │
   │   dev machine        │◀────────────────────────▶│   always-on server   │
   │   mlx-cluster        │      10.0.0.0/24         │   mlx_lm.server      │
   └──────────────────────┘                          └──────────────────────┘

   solo     one Mac serves the whole model — the other stays 100% free
   server   the M1 serves over the bridge — chat from anywhere on it
   cluster  one model tensor-sharded across BOTH Macs (/mode cluster)
            → 80 GB of combined unified memory for models neither can hold alone
```

> Everything here — guides, `mlxctl`, `mlx-cluster` — is built and tested against
> exactly two Macs, the pair in the diagram above. `mlx.launch`/MLX's
> distributed layer isn't inherently limited to two nodes, so a larger,
> N-Mac cluster is plausible in principle, but it's untested and unimplemented
> here (hostfile generation, `/mode`, and wear-leveling all assume two nodes).
> Fork it and adapt as needed if that's your use case.

## What's in the box

- **`mlx-cluster`** — terminal chat client + cluster operator: live CPU/GPU/RAM
  bars for both Macs, in-session model switching, wear-leveling so one machine
  doesn't take all the load, and `/mode cluster` to shard an oversized model
  across both — without leaving your chat.
- **`mlxctl`** — the model-cache manager `hf` should have shipped with: true
  on-disk sizes, per-shard download progress, stuck-download rescue, a
  will-it-fit verdict against your Mac's real wired-memory ceiling, and
  one-command server control (`mlxctl server start|stop|status`) that works
  the same whether you're on the server Mac or not.
- **Local coding agents** — `/agent <dir>` turns the chat client into a
  directory-scoped coding agent running entirely on your own model (four
  sandboxed tools, y/N confirmation for writes and shell). For heavier work
  there's an external [OpenCode](https://opencode.ai) harness — a worker
  agent plus a fresh-context evaluator that grades its diffs — gated by a
  per-directory allowlist (`harness allow`).
- **Verified guides** — single-Mac quickstart → Thunderbolt bridge → SSH mesh →
  distributed smoke test → always-on LaunchAgent server, each step actually
  run on the hardware in the diagram above.

Only the cluster pieces need two Macs — the quickstart and `mlxctl` are fully
standalone on a single Apple Silicon machine.

## Key features

- **Solo, server, or sharded** — `/mode solo|server|cluster` switches how a
  model is served mid-session, no restart, no leaving the chat.
- **Wear-leveling** — `/split 60/40` balances serving time between the two
  Macs so one doesn't quietly take all the GPU wear.
- **Live cluster stats** — per-node CPU/GPU/RAM/temp gauges, `/stats` to
  toggle combined vs. per-node view.
- **Memory-fit verdicts** — models and mode switches are checked against
  your Mac's real wired-memory ceiling before you commit to loading one.
- **In-chat coding agent** — `/agent <dir>` scopes the session to one
  directory and lets the local model read, write, and run commands there,
  with confirmation prompts and no cloud round-trips.
- **Zero cloud, ever** — every request stays on the Thunderbolt bridge or
  localhost; nothing leaves the desk.

## Quick start

> Requires an Apple Silicon Mac and Python 3.12+. A second Mac + a Thunderbolt
> cable only matter for the cluster features.

```sh
python3.12 -m venv ~/.venvs/mlx
~/.venvs/mlx/bin/pip install mlx-lm
export PATH="$HOME/.venvs/mlx/bin:$PATH"   # add to ~/.zshenv to persist

mlx_lm.chat --model mlx-community/Qwen3.5-9B-4bit --max-tokens 2048
```

That's a local LLM, chatting, on one Mac. Full walkthrough — this quick
start plus, when you're ready for the second Mac, the whole cluster build —
lives in [`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md).

For `mlxctl`, symlink it onto your `PATH` and run `mlxctl --help`:

```sh
ln -s "$PWD/src/tools/mlxctl" ~/.venvs/mlx/bin/mlxctl
```

## Running the cluster

[`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md) is the full verified
walkthrough — bridge IPs, SSH mesh, hostfile, smoke test, LaunchAgent, and
direct server access (`curl`/`ssh`/the zero-dep debug client) if you want it
raw. Once it's up, [`mlx-cluster`](./src/cli/README.md) handles daily
driving — `/mode`, `/model`, `/split` — including the sharded mode that used
to require hand-typed `mlx.launch` incantations.

## Documentation

- [`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md) — single Mac, zero to
  chatting, then the full two-Mac walkthrough, every command verified,
  gotchas included — ends with a go-to command cheatsheet grouped by task
- [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) — the system-level reference:
  a full-system flowchart, topology, data flow, and *why* the design is shaped
  this way (also where the Python-side dev/lint commands live)

Coding agents: `/agent [<dir>]` inside `mlx-cluster` needs no separate setup
(see its README); the heavier external OpenCode harness — worker + a
fresh-context evaluator, running on the cluster's own Qwen models — is
documented in `doc/ARCHITECTURE.md`'s "Coding-agent harness" section.

## License

[MIT](./LICENSE)
