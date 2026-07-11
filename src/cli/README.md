# mlx-cluster

Terminal chat client + lifecycle manager for the two-Mac MLX cluster
(see [`../../doc/CLUSTER_SETUP.md`](../../doc/CLUSTER_SETUP.md) and
[`../../doc/ARCHITECTURE.md`](../../doc/ARCHITECTURE.md)). Bun + TypeScript + Ink.

> Tested end-to-end on two Macs — an M1 Pro (32 GB) and an M5 Pro (48 GB)
> over Thunderbolt 4. Other Apple Silicon combinations should work but
> haven't been verified.

## What it does

- Attaches to (or bootstraps) the server Mac's `mlx_lm.server` LaunchAgent;
  falls back to a locally-spawned server if the other Mac is unreachable.
- Multi-turn streaming chat, markdown-rendered, with `/copy` to clipboard.
- Switches models (`/model`) and serving modes (`/mode solo | server |
  cluster`) mid-session — including tensor-parallel sharding across both
  Macs for models too big for one.
- Live per-node CPU/GPU/RAM/temp gauges via `macmon`, and wear-leveling so
  one Mac doesn't take all the serving load over time.
- `/agent [<dir>]` — a built-in coding agent confined to one directory:
  plain messages become tasks (bug fixes, doc writing, small features),
  writes and shell commands ask y/N first. Works on a single Mac — any
  server the CLI can reach is enough.
- Anything it started, it tears down on quit — including after a crash.

## Setup

1. Everything in `CLUSTER_SETUP.md` — bridge IPs, SSH keys, the server
   Mac's LaunchAgent — must already be working.
2. `brew install macmon && macmon serve --install` **on both Macs** (stats,
   port 9090).
3. Copy [`config.example.json`](./config.example.json) to
   `~/.mlx/cluster-cli.json` and fill in your usernames/IPs.
4. For `/mode cluster`, the `mlx.launch` hostfile from `CLUSTER_SETUP.md` §5
   must exist (default `~/.mlx/tb-ring-hostfile.json`).
5. `bun install`

## Run

```sh
bun run start                    # dev, from source
./install.sh                     # or: build + install standalone binary
mlx-cluster                  # after install.sh, from anywhere
mlx-cluster --model <repo>   # override the default/last-used model
```

## Commands

| Command | What |
|---|---|
| `/model [<repo>]` | list cached models / switch |
| `/mode [solo\|server\|cluster]` | show / switch how the model is served |
| `/agent [<dir>]` | coding agent here or in `<dir>` (read/write/bash, asks first) |
| `/agent off` | leave agent mode, back to plain chat |
| `/stats` | combined ↔ per-node stats |
| `/split [<ratio>]` | wear-leveling time-share target |
| `/copy` | copy the last reply |
| `/clear` | clear the transcript |
| `/help` | command help |
| `/quit`, `q` | quit |

`Esc` cancels a generation. `Ctrl+C` quits.

## Error handling

Every network/SSH call has a timeout and a specific message — no hangs, no
stack traces. Unreachable server → automatic local fallback; failed model
switch → old session preserved; crash → best-effort teardown still runs;
macmon down → "unavailable" in the stats bar, nothing else breaks.
