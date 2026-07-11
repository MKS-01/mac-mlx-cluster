# COMMANDS — go-to cheatsheet

The commands you actually reach for, grouped by task. Terse on purpose; the
*why* and the full walkthroughs live in [`CLUSTER_SETUP.md`](./CLUSTER_SETUP.md)
and [`ARCHITECTURE.md`](./ARCHITECTURE.md) (the latter also covers the OpenCode
coding-agent harness). Gotchas inline are ones this setup actually hit.

Topology assumed throughout: **M5 Pro 48 GB** = dev machine (`10.0.0.2`), **M1
Pro 32 GB** = always-on server (`10.0.0.1`), Thunderbolt bridge between them.

## Environment

```sh
source ~/.zshenv                      # if mlx_lm.*/mlxctl aren't on PATH in an open shell
# MLX venv: ~/.venvs/mlx  ·  models: ~/.cache/huggingface/hub  (neither in this repo)
```

## Models & cache — `mlxctl`

```sh
mlxctl list                           # all cached models: true size + complete/incomplete
mlxctl status <repo>                  # per-shard download progress (incomplete-aware)
mlxctl download <repo>                # download (refuses if one's already running)
mlxctl remove <repo>                  # delete a model entirely
mlxctl clean [repo]                   # kill stuck downloads, clear locks, drop stale .incomplete
mlxctl run <repo> [args]              # mlx_lm.chat on a model (repo = unique substring ok, e.g. 9b)
mlxctl search <query>                 # search mlx-community on the Hub
mlxctl meminfo [repo]                 # this Mac's wired-memory ceiling (+ fit verdict)
```

Gotchas: never `Ctrl+C` a download (restarts the shard from 0); only one download
at a time; a fully-downloaded model can still read `incomplete` (stale `.incomplete`
blobs — `mlxctl clean` is safe, `hf cache list` shows completed-only).

## Pattern A server (the M1's always-on LaunchAgent)

```sh
mlxctl server status                  # ●running / ○not — runs launchctl locally or over SSH
mlxctl server start                   # bring the M1 LaunchAgent server up
mlxctl server stop                    # unload it (a plain pkill just gets KeepAlive-respawned)
curl -s http://10.0.0.1:8080/v1/models | python3 -m json.tool   # what it's serving
```

## Local server (serve on the dev Mac itself)

```sh
# foreground, own terminal; loads the model lazily on first request (~19 GB → slow first hit)
HF_HUB_OFFLINE=1 mlx_lm.server --model mlx-community/Qwen3.6-35B-A3B-4bit-DWQ \
  --host 127.0.0.1 --port 8080

curl -s http://127.0.0.1:8080/v1/models >/dev/null && echo up || echo down
pkill -f mlx_lm.server                # stop it (nothing manages it — won't respawn)
```

One server per Mac, all clients share it — the CLI's local fallback and the
harness both talk to whatever's on `:8080`. Never start a second on the same Mac
(doubles model RAM).

## Cluster / sharding (model too big for one Mac)

Daily driver is the CLI: `/mode cluster [repo]` inside `mlx-cluster`. It stops
the M1 LaunchAgent first, launches the ring, health-checks rank 0, and tears the
whole group down on exit.

**Keep the M1 awake first** — it's a MacBook that sleeps, and a sleeping M1 makes
`mlx.launch`'s SSH to start rank 1 time out → `mlx.launch exited during startup
(code 0)`. This is the #1 cause of cluster-mode failures here:

```sh
ssh <user>@10.0.0.1 'nohup caffeinate -dimsu >/dev/null 2>&1 &'   # keep awake (no sudo; dies on reboot)
ssh <user>@10.0.0.1 'pkill -x caffeinate'                          # stop keeping awake
ssh <user>@10.0.0.1 'sudo pmset -c sleep 0'                        # permanent (needs sudo on the M1)
```

Manual launch (what the CLI runs — use it to see the FULL error; the CLI only
shows mlx.launch's last 8 stderr lines, which hides the real cause behind the
teardown traceback):

```sh
mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
  --python ~/.venvs/mlx/bin/python -- \
  ~/.venvs/mlx/bin/mlx_lm.server --model mlx-community/Qwen3.6-27B-4bit \
  --host 10.0.0.2 --port 8080
```

Healthy = rank 0's httpd comes up on `10.0.0.2:8080` (it only starts *after* the
ring forms, i.e. rank 1 on the M1 joined). Expect ~9–10 tok/s — sharding
aggregates memory, not speed. Model must be cached on **both** nodes
(`mlxctl status <repo>` on each; copy with the `model-transfer` skill if not).

## Coding-agent harness (OpenCode + local Qwen)

```sh
harness allow [path]                  # allow a project dir (default: .) — gate is enforced
harness list                          # ● allowed / ○ missing
harness deny <path>                   # remove one

cd <allowed-dir>
harness                               # interactive TUI  (/models to pick, /new, /undo, Esc)
harness run --dangerously-skip-permissions \
  -m mlx-local/mlx-community/Qwen3.6-35B-A3B-4bit-DWQ \
  "create index.html: a simple landing page"        # one-shot
```

Three things that look like bugs but aren't: pick the **`mlx-local/…`** model when
the M1 (`mlx-cluster`) is down; `harness run` needs `--dangerously-skip-permissions`
(else the write tool blocks on an approval prompt); keep one-shot prompts to **one
short line** (long `opencode run` prompts hang — known OpenCode bug, use the TUI).

Providers are global at `~/.config/opencode/opencode.json`, so any allowed folder
sees `mlx-local`/`mlx-cluster` with no per-project config. Needs a server up on
`:8080` (local or the M1). See `ARCHITECTURE.md`'s "Coding-agent harness" section.

## mlx-cluster

```sh
cd src/cli && bun run dev             # run from source
bun run build                         # → dist/mlx-cluster
bun run setup                         # install to ~/.local/bin (override: MLX_CLI_BIN_DIR)
```

In-session: `/mode solo|server|cluster` · `/model [repo]` · `/agent [dir]` ·
`/split 60/40` · `/stats` · `/help`. Config `~/.mlx/cluster-cli.json`, prefs
`~/.mlx/cluster-cli-prefs.json` (don't hand-edit while running).

### In-CLI coding agent (`/agent`)

Single-Mac friendly: it talks to whatever server the CLI is already using —
solo mode / the local fallback on `:8080` is enough. No OpenCode, no second
machine, no per-project config.

```
/agent               # agent mode in the dir the CLI was launched from
/agent <dir>         # …or scoped to another project directory
/agent off           # back to plain chat (a new <dir> also resets the session)
```

Plain messages then become tasks — "fix the failing test in x.py", "write a
README for this folder", "add --json to the status command". The agent reads
and lists freely; every `write_file`/`bash` pauses on a y/N prompt; Esc
declines/cancels. It's confined to the chosen directory (paths that escape it
are refused). Model comes from `agentModel` in the config, independent of the
chat model.

## Diagnostics & cleanup

```sh
ping -c 3 10.0.0.1                                     # bridge link (M1)
ssh -o BatchMode=yes -o ConnectTimeout=6 <user>@10.0.0.1 hostname   # SSH + M1 awake?
ssh-add -l                                            # key loaded? (empty agent = SSH will fail)
ssh-add --apple-use-keychain ~/.ssh/id_ed25519        # load passphrase key from Keychain

# who's serving / stuck processes, either node
pgrep -fl 'mlx_lm.server|mlx.launch'
ssh <user>@10.0.0.1 'pgrep -fl mlx_lm.server'
lsof -iTCP:8080 -sTCP:LISTEN -n -P                    # who holds :8080

pkill -f mlx_lm.server                                # local sweep
ssh <user>@10.0.0.1 'pkill -f mlx_lm.server'             # remote sweep
```

Deeper flows have skills: `/debug` (cluster/CLI misbehaving), `/ssh-check` (bridge
+ keys), `/cleanup` (stuck downloads, orphans, repo hygiene), `/model-transfer`
(copy a model between Macs).
