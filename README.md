# mac-mlx-cluster

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Platform: Apple Silicon](https://img.shields.io/badge/platform-Apple%20Silicon-black?logo=apple)
![Python: 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python&logoColor=white)
![Powered by MLX](https://img.shields.io/badge/powered%20by-MLX-orange)

It started on a weekend out of curiosity: could an M-series Mac actually run a
real LLM locally, no cloud involved? `mlx_lm.chat` said yes. That led to a
second question — could two idle Macs do more together than either one
alone? First attempt was [exo](https://github.com/exo-explore/exo) — it
worked. Then [WWDC 2026 session 233](https://developer.apple.com/videos/play/wwdc2026/233/)
showed the MLX-native way to do the same thing with `mlx.launch`, and the
part of me that would rather automate a setup than repeat it by hand
decided the exo detour needed converting over — and, while at it, wrapping
in an actual terminal CLI instead of raw commands. A Thunderbolt cable, a
lot of trial and error, and a few very literal "why did that just hang for
two minutes" debugging sessions later, all of it worked.

This repo is what came out of that weekend, kept going: tooling and guides
for running [MLX](https://github.com/ml-explore/mlx) LLMs on Apple Silicon —
on a single Mac, or distributed across a two-Mac cluster over Thunderbolt.
Nothing here is theoretical — every command in
[`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md) is one that was actually
run, against a real M1 Pro + M5 Pro sitting on the same desk.

## What's in here

- **A model cache manager** (`mlxctl`) — list/download/remove/clean Hugging Face-cached
  MLX models with incomplete-download-aware status, no more guessing why a model won't load.
- **A single-Mac quickstart** — get `mlx-lm` chatting with a model in a few commands.
- **A two-Mac cluster walkthrough** — Thunderbolt bridge, SSH, hostfile, distributed
  smoke tests, and a dedicated always-on model server (LaunchAgent).
- **A terminal chat client** (`mlx-cluster-cli`) — Bun/TypeScript/Ink app that manages
  the cluster's server lifecycle, live CPU/GPU/RAM stats, model switching, and
  wear-leveling between the two Macs, all from one interactive session.

Only the cluster pieces need two Macs — the quickstart and `mlxctl` work standalone on
a single Apple Silicon Mac.

## Contents

| File | What it is |
|------|------------|
| [`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md) | System-level reference: topology, data flow, and the CLI's internal design |
| [`doc/ROADMAP.md`](./doc/ROADMAP.md) | Planned but not-yet-built work |
| [`src/mlxctl`](./src/mlxctl) | A colorful CLI to list, download, inspect, and clean cached MLX/Hugging Face models |
| [`doc/MLX_QUICKSTART.md`](./doc/MLX_QUICKSTART.md) | Get `mlx-lm` running and chat with a model in a few commands |
| [`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md) | Verified two-Mac cluster walkthrough: Thunderbolt bridge, SSH, hostfile, distributed smoke tests, and an always-on model server |
| [`src/cluster/chat.py`](./src/cluster/chat.py) | Zero-dependency interactive chat client for any OpenAI-compatible endpoint |
| [`src/cli/`](./src/cli/) | `mlx-cluster-cli` — terminal chat client + lifecycle manager for the cluster (Bun/TypeScript/Ink) |

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
ln -s "$PWD/src/mlxctl" ~/.venvs/mlx/bin/mlxctl
```

| Command | Description |
|---------|-------------|
| `mlxctl list` | All cached models with true size + status (counts in-progress downloads) |
| `mlxctl status <repo>` | Per-shard download progress for one model |
| `mlxctl download <repo>` | Download a model (refuses if one is already running) |
| `mlxctl remove <repo>` | Delete a model from the cache |
| `mlxctl clean [repo]` | Clear stale locks / kill a stuck download + drop partials |
| `mlxctl run <repo> [args]` | Launch `mlx_lm.chat` (repo accepts a unique substring, e.g. `9b`) |
| `mlxctl search <query>` | Search `mlx-community` on the Hub |
| `mlxctl meminfo [repo]` | This Mac's wired-memory ceiling (+ a fit verdict for a cached model) |

**Configuration** (optional env vars):
- `MLX_VENV` — path to the MLX virtualenv (default `~/.venvs/mlx`). `mlxctl` invokes
  `hf` and `mlx_lm.chat` from its `bin/`, falling back to `PATH` if not found.
- `HF_HOME` — Hugging Face cache location (default `~/.cache/huggingface`).

## Cluster cheat sheet

Assumes the two-Mac setup from [`doc/CLUSTER_SETUP.md`](./doc/CLUSTER_SETUP.md)
(server Mac = `10.0.0.1` on the Thunderbolt bridge, `<user>` = your username).

**Model server** (LaunchAgent on the server Mac):

```sh
ssh <user>@10.0.0.1 'launchctl kickstart -k gui/$(id -u)/com.mlx-server'   # start / restart
ssh <user>@10.0.0.1 'launchctl bootout gui/$(id -u)/com.mlx-server'       # stop (until next login)
ssh <user>@10.0.0.1 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mlx-server.plist'  # re-enable
ssh <user>@10.0.0.1 'tail -20 ~/Library/Logs/mlx-server.log'              # logs
curl -s http://10.0.0.1:8080/v1/models                                    # health check
python3 src/cluster/chat.py                                               # interactive chat
```

**Networking:**

```sh
ifconfig bridge0 | grep -E 'status|inet '        # Thunderbolt bridge link + IP
ping -c 2 10.0.0.1                               # reach the other Mac (~1-2 ms)
sudo networksetup -setmanual "Thunderbolt Bridge" 10.0.0.2 255.255.255.0   # set static IP
ssh -o BatchMode=yes <user>@10.0.0.1 hostname    # passwordless SSH check
```

**Distributed MLX:**

```sh
# cluster smoke test (all_sum across both Macs)
mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
    --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/ring_test.py"

# sharded inference test (memory + tok/s per rank)
mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
    --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/tp_test.py" [model-repo]

# interactive distributed chat (real TTY only — don't pipe stdin)
mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
    --python "$HOME/.venvs/mlx/bin/python" -- \
    "$HOME/.venvs/mlx/bin/mlx_lm.chat" --model <repo> --max-tokens 2048
```

## Development

```sh
~/.venvs/mlx/bin/pip install -r src/requirements.txt -r src/requirements-dev.txt
ruff check src/mlxctl      # lint
ruff format src/mlxctl     # format
```

For `src/cli/` (the TypeScript chat client), see [`src/cli/README.md`](./src/cli/README.md).

## Contributing

Issues and PRs are welcome. This is still, at heart, a weekend curiosity
project — verified end-to-end only on the hardware in
[`doc/ARCHITECTURE.md`](./doc/ARCHITECTURE.md#hardware-topology)
(M1 Pro 32GB + M5 Pro 48GB over Thunderbolt 4) — if you run it on a different
Apple Silicon combination, a PR noting what worked or didn't is especially useful.
For non-trivial changes to `src/cli/`, read `doc/ARCHITECTURE.md` first; it explains
the design decisions behind the code, not just what the code does.

## License

[MIT](./LICENSE)
