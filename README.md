# mac-mlx-cluster

*Chat with a local LLM on one Mac. Or shard a bigger one across two, over a
Thunderbolt cable, with no cloud in between.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Platform: Apple Silicon](https://img.shields.io/badge/platform-Apple%20Silicon-black?logo=apple)
![Python: 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python&logoColor=white)
![Powered by MLX](https://img.shields.io/badge/powered%20by-MLX-orange)

<!--
Screenshot pending — drop it in doc/img/ (e.g. doc/img/cli.png) and swap
the line below for: ![mlx-cluster-cli](./doc/img/cli.png)
-->

## The weekend this came from

It started out of curiosity: could an M-series Mac actually run a real LLM
locally, no cloud involved? `mlx_lm.chat` said yes. That led to a second
question — could two idle Macs do more together than either one alone?
First attempt was [exo](https://github.com/exo-explore/exo) — it worked.
Then [WWDC 2026 session 233](https://developer.apple.com/videos/play/wwdc2026/233/)
showed the MLX-native way to do the same thing with `mlx.launch`, and the
part of me that would rather automate a setup than repeat it by hand
decided the exo detour needed converting over — and, while at it, wrapping
in an actual terminal CLI instead of raw commands. A Thunderbolt cable, a
lot of trial and error, and a few very literal "why did that just hang for
two minutes" debugging sessions later, all of it worked.

This repo is what came out of that weekend, kept going: tooling and guides
for running [MLX](https://github.com/ml-explore/mlx) LLMs on Apple Silicon.
Nothing here is theoretical — every command in
[`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md) is one that was actually
run, against a real M1 Pro + M5 Pro sitting on the same desk.

## Three ways to run it

```
one Mac              mlx_lm.chat — everything local, nothing else needed
two Macs, default    M1 always serves · your other Mac talks to it over Thunderbolt
two Macs, sharded    one model split across both, via mlx.launch --backend ring
                     (/mode cluster) — for models too big for either Mac alone
```

## What's in here

- **`mlxctl`** — a colorful CLI for the Hugging Face model cache: list, download,
  remove, clean stale partial downloads, check whether a model will fit in RAM.
- **A single-Mac quickstart** — get `mlx_lm.chat` talking to a model in a few commands.
- **A two-Mac cluster walkthrough** — Thunderbolt bridge, SSH, hostfile, distributed
  smoke tests, and a dedicated always-on model server (LaunchAgent).
- **`mlx-cluster-cli`** — a terminal chat client that manages the server lifecycle,
  live CPU/GPU/RAM stats, model switching, wear-leveling between the two Macs, and
  on-demand sharded serving (`/mode cluster`) for oversized models — all from one
  interactive session.

Only the cluster pieces need two Macs — the quickstart and `mlxctl` work standalone
on a single Apple Silicon Mac.

## Requirements

- Apple Silicon Mac (M-series). A second Mac + a Thunderbolt cable is only needed for
  the cluster features — everything else runs standalone.
- Python 3.12+
- [`mlx-lm`](https://github.com/ml-explore/mlx-lm) (pulls in `mlx`, `huggingface_hub`, etc.)

## Quick start

Install [`mlx-lm`](https://github.com/ml-explore/mlx-lm) into a virtualenv (Apple Silicon only):

```sh
python3.12 -m venv ~/.venvs/mlx
~/.venvs/mlx/bin/pip install mlx-lm
export PATH="$HOME/.venvs/mlx/bin:$PATH"   # add to ~/.zshenv to persist
```

Chat with a model:

```sh
mlx_lm.chat --model mlx-community/Qwen3.5-9B-4bit --max-tokens 2048
```

See [`doc/MLX_QUICKSTART.md`](./doc/MLX_QUICKSTART.md) for details.

## `mlxctl`

Make it available on your PATH (e.g. symlink into your venv's bin):

```sh
ln -s "$PWD/src/tools/mlxctl" ~/.venvs/mlx/bin/mlxctl
```

| Command | Description |
|---------|-------------|
| `mlxctl list` | All cached models with true size + status (counts in-progress downloads) |
| `mlxctl status <repo>` | Per-shard download progress for one model |
| `mlxctl download <repo>` | Download a model (refuses if one is already running) |
| `mlxctl remove <repo>` | Delete a model from the cache entirely, complete or not |
| `mlxctl clean [repo]` | Kill a stuck download, clear stale locks, drop stale partial files only — never touches complete files |
| `mlxctl run <repo> [args]` | Launch `mlx_lm.chat` (repo accepts a unique substring, e.g. `9b`) |
| `mlxctl search <query>` | Search `mlx-community` on the Hub |
| `mlxctl meminfo [repo]` | This Mac's wired-memory ceiling (+ a fit verdict for a cached model) |

**Configuration** (optional env vars):
- `MLX_VENV` — path to the MLX virtualenv (default `~/.venvs/mlx`). `mlxctl` invokes
  `hf` and `mlx_lm.chat` from its `bin/`, falling back to `PATH` if not found.
- `HF_HOME` — Hugging Face cache location (default `~/.cache/huggingface`).

## Cluster quick reference

Full walkthrough (bridge setup, SSH, hostfile, distributed smoke tests) is in
[`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md) — read that first if you're
setting this up for the first time. Once it's running, `mlx-cluster-cli`
drives day-to-day use, including sharding a model across both Macs
(`/mode cluster`) without needing the raw `mlx.launch` commands by hand.

For direct access to the always-on server (server Mac = `10.0.0.1` on the
bridge, `<user>` = your username):

```sh
ssh <user>@10.0.0.1 'launchctl kickstart -k gui/$(id -u)/com.mlx-server'   # restart
ssh <user>@10.0.0.1 'launchctl bootout gui/$(id -u)/com.mlx-server'        # stop
curl -s http://10.0.0.1:8080/v1/models                                     # health check
python3 src/tools/chat.py                                                  # debug/test client
```

## Development

```sh
~/.venvs/mlx/bin/pip install -r src/tools/requirements.txt -r src/tools/requirements-dev.txt
ruff check src/tools/mlxctl      # lint
ruff format src/tools/mlxctl     # format
```

For `src/cli/` (the TypeScript chat client), see [`src/cli/README.md`](./src/cli/README.md).

## Documentation

| File | What it is |
|------|------------|
| [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) | System-level reference: topology, data flow, and the CLI's internal design |
| [`doc/MLX_QUICKSTART.md`](./doc/MLX_QUICKSTART.md) | Get `mlx-lm` running and chat with a model in a few commands |
| [`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md) | Verified two-Mac cluster walkthrough: Thunderbolt bridge, SSH, hostfile, distributed smoke tests, and an always-on model server |
| [`doc/ROADMAP.md`](./doc/ROADMAP.md) | Planned but not-yet-built work |
| [`src/cli/README.md`](./src/cli/README.md) | `mlx-cluster-cli` setup, commands, and error-handling reference |
| [`src/tools/chat.py`](./src/tools/chat.py) | Zero-dependency debugging/testing client for any OpenAI-compatible endpoint |
| [`src/tools/dist_bench.py`](./src/tools/dist_bench.py) | Distributed smoke test + tensor-parallel benchmark, run under `mlx.launch` |


## License

[MIT](./LICENSE)
