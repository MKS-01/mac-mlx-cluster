# mac-mlx-cluster

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform: Apple Silicon](https://img.shields.io/badge/platform-Apple%20Silicon-black?logo=apple)
![Python: 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python&logoColor=white)
![Powered by MLX](https://img.shields.io/badge/powered%20by-MLX-orange)

Tooling and guides for running [MLX](https://github.com/ml-explore/mlx) LLMs locally on
Apple Silicon — on a single Mac, or distributed across a two-Mac cluster.

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

## Requirements

- Apple Silicon Mac (M-series)
- Python 3.12+
- `mlx-lm` (pulls in `mlx`, `huggingface_hub`, etc.)

## Development

```sh
~/.venvs/mlx/bin/pip install -r src/requirements.txt -r src/requirements-dev.txt
ruff check src/mlxctl      # lint
ruff format src/mlxctl     # format
```

## License

[MIT](./LICENSE)
