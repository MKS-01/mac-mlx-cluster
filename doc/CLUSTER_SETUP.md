# MLX setup: single Mac to a two-Mac cluster

Everything needed to run local LLMs on Apple Silicon with MLX — from a
single Mac's first chat session up through sharding a model too big for one
Mac across two, over a direct Thunderbolt cable.

The [single-Mac section](#single-mac-install-and-chat) below is all you need
on one machine. Everything after it needs a second Mac and a Thunderbolt
cable, and is a step-by-step record of what was actually run — verified
working on an M5 Pro (48 GB) + M1 Pro (32 GB) over Thunderbolt 4, based on
the workflow from [WWDC 2026 session 233](https://developer.apple.com/videos/play/wwdc2026/233/),
adapted for Thunderbolt 4 (see [Backend choice](#backend-choice-ring-not-jaccl)).
Throughout the cluster sections, **node A** is the Mac you launch from
(rank 0) and **node B** is the other Mac (rank 1). Adjust usernames/IPs to
your machines, and run the command blocks **from the repo root** (paths
like `src/tools/dist_bench.py` are repo-relative).

## Single Mac: install and chat

Run local LLMs on your Mac's GPU with Apple's MLX framework — no second Mac
needed for this part.

### Install

```sh
python3.12 -m venv ~/.venvs/mlx
~/.venvs/mlx/bin/pip install mlx-lm
export PATH="$HOME/.venvs/mlx/bin:$PATH"   # add to ~/.zshenv to persist
```

If you open a shell and `mlx_lm.*`/`mlxctl` aren't found, reload once:
`source ~/.zshenv`.

### Run a chat session

```sh
mlx_lm.chat --model mlx-community/Qwen3.5-9B-4bit --max-tokens 2048
```

- You get a `>>` prompt — type a message, press Enter, read the reply, repeat.
  Exit with `Ctrl+D` or `Ctrl+C`.
- First run of any *new* model downloads weights (a few GB) to
  `~/.cache/huggingface/hub`; later runs load instantly from cache.
- `Qwen3.5-9B` is a **reasoning model** — it prints its thinking before the
  final answer, so a high `--max-tokens` (2048+) is recommended. For real
  use, see `CLAUDE.md`'s "Model selection" section (prefer the newest Qwen,
  sized to your Mac's RAM).

### Useful flags (`mlx_lm.chat`)

| Flag | Purpose |
|------|---------|
| `--model <repo>` | Hugging Face repo id (e.g. `mlx-community/Qwen3.5-9B-4bit`) |
| `--max-tokens 2048` | Max tokens to generate per reply |
| `--temp 0.7` | Sampling temperature (higher = more random) |
| `--top-p 0.9` | Nucleus sampling cutoff |
| `--seed 0` | Reproducible output |
| `--max-kv-size N` | Cap the KV cache (limits context memory) |

### Other MLX commands

```sh
# One-shot generation (non-interactive, scriptable)
mlx_lm.generate --model mlx-community/Qwen3.5-9B-4bit \
  --prompt "Explain unified memory in one paragraph." --max-tokens 512

# OpenAI-compatible local API server (http://localhost:8080)
mlx_lm.server --model mlx-community/Qwen3.5-9B-4bit

# Convert / quantize a HF model to MLX format
mlx_lm.convert --hf-path <hf-repo> -q

# Benchmark tokens/sec
mlx_lm.benchmark --model mlx-community/Qwen3.5-9B-4bit
```

### Managing the model cache

Use `mlxctl` (`src/tools/mlxctl` in this repo, symlink it onto your `PATH` —
see the root `README.md`) instead of raw `hf`/`rm -rf`: it understands
in-progress downloads and stuck locks that `hf cache list` and a manual
`rm -rf` don't.

```sh
mlxctl list                 # every cached model, true size, complete/incomplete
mlxctl status <repo>        # per-shard download progress
mlxctl remove <repo>        # delete a model entirely
mlxctl clean [repo]         # kill stuck downloads, clear stale locks/.incomplete blobs
mlxctl search <query>       # find a repo on the Hub if you don't have the exact id
```

Full command reference (models, servers, cluster, diagnostics): this doc's
[Command cheatsheet](#command-cheatsheet) section at the end.

### Troubleshooting

- **`zsh: command not found: mlx_lm.chat`** → run `source ~/.zshenv`, or open
  a new terminal. (PATH is set in `~/.zshenv`.)
- **Wrong model name / 404** → browse <https://huggingface.co/mlx-community>
  for the exact repo id (names often include `-MLX-`, `-4bit`, `-8bit`), or
  `mlxctl search <query>`.
- **EOFError traceback when piping a prompt** → harmless; the REPL hit
  end-of-input after one prompt. Only happens with piped input, not normal
  interactive use.
- **Download seems stuck, or a fully-downloaded model still shows
  "incomplete"** → see `CLAUDE.md`'s "Download gotchas" section: never
  `Ctrl+C` a download, and `mlxctl clean <repo>` clears the stale markers
  that cause this without touching a complete model's files.

## Two-Mac cluster (Thunderbolt, ring backend)

Everything from here on needs a second Mac and a Thunderbolt cable.

### 1. Physical link

Connect the Macs with a Thunderbolt cable. macOS creates a **Thunderbolt Bridge**
interface (`bridge0`) automatically. Verify the link is active:

```sh
ifconfig bridge0 | grep status    # want: status: active
```

### 2. Static IPs on the bridge

By default the bridge self-assigns a 169.254.x.x address. Give each Mac a fixed
IP so the hostfile stays stable:

```sh
# on node A (rank 0)
sudo networksetup -setmanual "Thunderbolt Bridge" 10.0.0.2 255.255.255.0
# on node B (rank 1)
sudo networksetup -setmanual "Thunderbolt Bridge" 10.0.0.1 255.255.255.0
```

Verify: `ping -c 2 10.0.0.1` from node A (expect ~1–2 ms over TB4).

### 3. SSH everywhere (including to yourself)

`mlx.launch` starts every rank over SSH — **including the local one** — so both
Macs need Remote Login enabled and key-based auth.

1. On **both** Macs: System Settings → General → Sharing → **Remote Login** on
   (or `sudo systemsetup -setremotelogin on`).
2. From node A, authorize your key on node B and on node A itself (create a key
   first with `ssh-keygen -t ed25519` if `~/.ssh/id_ed25519.pub` doesn't exist;
   adjust the filename if your key is another type):

```sh
ssh-copy-id <user>@10.0.0.1                          # node B
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys  # node A (self)
chmod 600 ~/.ssh/authorized_keys
```

3. Check both work without a password (`accept-new` records each host key on
   first contact — without it the self-SSH check fails with "Host key
   verification failed" even though key auth is fine):

```sh
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new <user>@10.0.0.1 hostname
ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new <user>@10.0.0.2 hostname
```

### 4. MLX on both Macs

Each node needs its own MLX venv, **with matching `mlx` versions**:

```sh
python3 -m venv ~/.venvs/mlx
~/.venvs/mlx/bin/pip install mlx mlx-lm
~/.venvs/mlx/bin/python -c "import mlx.core as mx; print(mx.__version__)"
```

Everything below assumes the venv lives at `~/.venvs/mlx` on both machines.

### 5. Hostfile

Copy [`hostfile.example.json`](../src/tools/hostfile.example.json) to `~/.mlx/tb-ring-hostfile.json`
and edit the user/IPs. The first entry is rank 0:

```json
[
  {"ssh": "<user>@10.0.0.2", "ips": ["10.0.0.2"]},
  {"ssh": "<user>@10.0.0.1", "ips": ["10.0.0.1"]}
]
```

### 6. Smoke test

`mlx.launch` does **not** copy your script — it must exist at the same absolute
path on every node. Put shared scripts somewhere identical on both Macs
(e.g. `~/.mlx/`). [`dist_bench.py`](../src/tools/dist_bench.py) doubles as
both the connectivity smoke test (below) and the tensor-parallel benchmark
in §7 — copy it once here and it's ready for both:

```sh
mkdir -p ~/.mlx && cp src/tools/dist_bench.py ~/.mlx/
ssh <user>@10.0.0.1 'mkdir -p ~/.mlx'
scp src/tools/dist_bench.py <user>@10.0.0.1:.mlx/

mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
    --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/dist_bench.py"
```

Expected output — each rank reports the sum over both nodes:

```
rank 0/2 all_sum -> [2.0, 2.0, 2.0, 2.0]
rank 1/2 all_sum -> [2.0, 2.0, 2.0, 2.0]
```

### 7. Distributed inference (sharding a model across both Macs)

Only worth it for models too big for one Mac — sharding aggregates memory, not
speed. The `mlx-cluster` chat client can drive this whole section for you
(`/mode cluster [<model>]` — see `src/cli/README.md`); what follows is the
underlying manual mechanism, which the CLI wraps. Two modes, chosen per model
architecture:

- **Tensor parallel** (default): every layer split across nodes. Needs an
  all-reduce per layer, so it's the chattier option, but it's what most
  models in `mlx_lm` support (anything with a `shard` method — including
  Qwen3.6 MoE).
- **Pipeline** (`--pipeline`): first half of the layers on rank 0, second half
  on rank 1. Only for architectures whose `mlx_lm` model class implements
  `pipeline()` — if not, you get
  `ValueError: The model does not support pipelining`.

The model snapshot must be in the HF cache on **every** node. Copy it over the
bridge (the `mkdir` matters — macOS's bundled rsync won't create missing parents):

```sh
ssh <user>@10.0.0.1 'mkdir -p ~/.cache/huggingface/hub'
rsync -a ~/.cache/huggingface/hub/models--<org>--<repo> <user>@10.0.0.1:.cache/huggingface/hub/
```

Interactive chat (needs a real TTY — don't pipe stdin into `mlx.launch`, it
corrupts the launcher's own bookkeeping):

```sh
mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
    --python "$HOME/.venvs/mlx/bin/python" -- \
    "$HOME/.venvs/mlx/bin/mlx_lm.chat" \
    --model <repo> --max-tokens 2048
```

For a scripted test, pass a model repo to the same `dist_bench.py` you
already copied to both nodes in §6 (uses the `sharded_load` API and prints
each rank's memory + tok/s):

```sh
mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
    --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/dist_bench.py" [model-repo]
```

**Measured** (Qwen3.6-35B-A3B-4bit-DWQ, ~19 GB, tensor parallel over TB4):
each rank held 10.9 GB of weights — half the model per Mac — generating at
~9.6 tok/s. Note this model **fits on one Mac** and was chosen only to smoke-test
the mechanism; for real use it belongs on a single node as a server (§8), where
it runs 3–4× faster. Shard only what one Mac can't hold.

### 8. Dedicated model server (LaunchAgent)

If the model fits on one Mac, don't shard — run it whole on the "server" Mac
and keep the other machine's memory 100% free. Tensor parallelism can't do
uneven splits (55/45, 60/40): ranks always get equal shares, model dims must
divide by the rank count, and stacking multiple ranks on one GPU to fake a
ratio caused Metal GPU timeouts on the M1. Pattern A is the better answer.

Install [`mlx-server.example.plist`](../src/tools/mlx-server.example.plist) on the server
Mac — **first edit the file**: replace `USERNAME` (3 places) and set your model
and bind IP/port. Then:

```sh
# edit src/tools/mlx-server.example.plist before copying!
ssh <user>@10.0.0.1 'mkdir -p ~/Library/LaunchAgents'
scp src/tools/mlx-server.example.plist <user>@10.0.0.1:Library/LaunchAgents/com.mlx-server.plist
ssh <user>@10.0.0.1 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mlx-server.plist'
```

Notes on the plist:
- Binds to the Thunderbolt bridge IP only (`10.0.0.1`) — not reachable from
  Wi-Fi/LAN. Trade-off: the bridge IP must exist for the bind to succeed, so
  after a reboot with the cable unplugged the server exits and launchd retries
  every 60 s until the link is back. Bind `0.0.0.0` instead if you want
  LAN access / cable-optional startup.
- `KeepAlive` with `SuccessfulExit=false` restarts it on crash but respects a
  deliberate stop; `HF_HUB_OFFLINE=1` makes startup instant/offline (model must
  already be in the HF cache — remove it for download-on-first-start).
- `launchctl bootstrap gui/...` needs that user logged into the Mac's GUI (the
  gui domain doesn't exist for SSH-only sessions). Log in at the console once;
  after that it survives reboots on its own.
- Logs: `~/Library/Logs/mlx-server.log` on the server Mac.

Manage it:

```sh
ssh <user>@10.0.0.1 'launchctl kickstart -k gui/$(id -u)/com.mlx-server'  # restart
ssh <user>@10.0.0.1 'launchctl bootout gui/$(id -u)/com.mlx-server'      # stop + disable
```

Use it from the other Mac — OpenAI-compatible API:

```sh
curl -s http://10.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"mlx-community/Qwen3.6-35B-A3B-4bit-DWQ",
       "messages":[{"role":"user","content":"hello"}],"max_tokens":256}'
```

Or point any OpenAI SDK at `base_url="http://10.0.0.1:8080/v1"` (any API key),
or — to test more than one exchange without building `mlx-cluster` —
use this repo's zero-dependency debugging/testing client:

```sh
python3 src/tools/chat.py                # default server http://10.0.0.1:8080
python3 src/tools/chat.py --url http://localhost:8080   # or set $MLX_SERVER_URL
```

### 9. Wired-memory limit (large models on the server Mac)

`mlx_lm.server` already wires each generation's memory automatically —
`mlx_lm/generate.py`'s `wired_limit()` context manager calls
`mx.set_wired_limit(mx.device_info()["max_recommended_working_set_size"])`
before every request. Nothing to configure there. What *does* need
attention is the **OS ceiling** that value is capped by: the sysctl
`iogpu.wired_limit_mb` (macOS 15+ only). Check it:

```sh
mlxctl meminfo               # total RAM, MLX's max recommended working set, current sysctl value
mlxctl meminfo <repo>        # + a fit verdict for one cached model
```

If a model is close to or over the ceiling, `mlx_lm.server`'s log
(`~/Library/Logs/mlx-server.log`) will show
`[WARNING] Generating with a model that requires ... This can be slow`
and fall back to slower paged memory instead of wiring the model in.

Raise the ceiling:

```sh
sudo sysctl iogpu.wired_limit_mb=N   # N in MB — bigger than the model, smaller than total RAM
```

This **does not survive a reboot** on its own. To persist it, install
[`wired-limit.example.plist`](../src/tools/wired-limit.example.plist) as a
**LaunchDaemon** (system domain — unlike the server's LaunchAgent above, this
one doesn't need a logged-in GUI session to load):

```sh
# edit wired-limit.example.plist first — replace N with your chosen megabyte value
scp src/tools/wired-limit.example.plist <user>@10.0.0.1:/tmp/
ssh <user>@10.0.0.1 'sudo cp /tmp/wired-limit.example.plist /Library/LaunchDaemons/com.mlx-wired-limit.plist && \
  sudo launchctl bootstrap system /Library/LaunchDaemons/com.mlx-wired-limit.plist'
```

### Backend choice: ring, not jaccl

`--backend jaccl` (RDMA over Thunderbolt 5, what the WWDC demo uses) is the
better choice whenever every node actually supports it — lower latency,
higher throughput, no reason not to take it if you can. The catch is it
needs TB5 on **every** node, not just one. This repo's pair is mismatched
(M5 Pro has TB5, the M1 Pro only has TB4), so JACCL isn't reachable here no
matter how the cable's wired — the fallback for exactly this case is the
default TCP `ring` backend over the bridge IPs. Same hostfile shape, just no
`"rdma"` entries. If your two Macs both have TB5, use `jaccl` instead; this
guide's `ring` instructions still apply verbatim otherwise.

### Gotchas we hit

- **`mlx.launch` exit 127** — pass `--python` as an absolute path; `~` inside
  the argument doesn't expand on the remote side.
- **"can't open file" on a rank** — the script path must exist on *that* node;
  `mlx.launch` doesn't copy it.
- **`mlx.distributed_config --over thunderbolt`** wants sudo to tear down
  `bridge0` and re-IP the raw Thunderbolt port (`en1`) as a point-to-point link.
  That kills any SSH session running over the bridge mid-setup. The manual
  bridge IPs above work fine for the ring backend; only bother with the tool's
  auto-setup if you need JACCL/RDMA.
- **Version skew** — keep `mlx` the same version on all nodes.
- **Different usernames / home paths** — `"$HOME/..."` in the launch commands
  expands on node A only; the resulting absolute path must also exist on node B.
  If usernames differ between the Macs, use a path that exists on both or
  symlink one.

## Command cheatsheet

The commands you actually reach for day to day, once everything above is set
up — grouped by task, terse on purpose. The *why* is in the sections above and
in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (which also covers the OpenCode
coding-agent harness); this is just the quick reference.

```sh
source ~/.zshenv                      # if mlx_lm.*/mlxctl aren't on PATH in an open shell
# MLX venv: ~/.venvs/mlx  ·  models: ~/.cache/huggingface/hub  (neither in this repo)
```

### Pattern A server (the M1's always-on LaunchAgent)

```sh
mlxctl server status                  # ●running / ○not — runs launchctl locally or over SSH
mlxctl server start                   # bring the M1 LaunchAgent server up
mlxctl server stop                    # unload it (a plain pkill just gets KeepAlive-respawned)
curl -s http://10.0.0.1:8080/v1/models | python3 -m json.tool   # what it's serving
```

### Cluster / sharding: keep the M1 awake

`/mode cluster [repo]` inside `mlx-cluster` is the daily driver (§7 above). The
#1 cause of cluster-mode failures here: the M1 is a MacBook that sleeps, and a
sleeping M1 makes `mlx.launch`'s SSH to start rank 1 time out →
`mlx.launch exited during startup (code 0)`.

```sh
ssh <user>@10.0.0.1 'nohup caffeinate -dimsu >/dev/null 2>&1 &'   # keep awake (no sudo; dies on reboot)
ssh <user>@10.0.0.1 'pkill -x caffeinate'                          # stop keeping awake
ssh <user>@10.0.0.1 'sudo pmset -c sleep 0'                        # permanent (needs sudo on the M1)
```

If a cluster launch fails, the manual command in §7 (run directly instead of
through the CLI) shows the FULL error — the CLI only shows `mlx.launch`'s last
8 stderr lines, which hides the real cause behind the teardown traceback.

### Coding-agent harness (OpenCode + local Qwen)

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
sees `mlx-local`/`mlx-cluster` with no per-project config. Full detail in
`ARCHITECTURE.md`'s "Coding-agent harness" section.

### `mlx-cluster` (the chat client)

```sh
cd src/cli && bun run dev             # run from source
bun run build                         # → dist/mlx-cluster
bun run setup                         # install to ~/.local/bin (override: MLX_CLI_BIN_DIR)
```

In-session: `/mode solo|server|cluster` · `/model [repo]` · `/agent [dir]` ·
`/split 60/40` · `/stats` · `/help`. Config `~/.mlx/cluster-cli.json`, prefs
`~/.mlx/cluster-cli-prefs.json` (don't hand-edit while running).

`/agent [<dir>]` is a single-Mac-friendly coding agent built into the client —
it talks to whatever server the session is already using, no OpenCode or
second machine needed. See `src/cli/README.md` and `ARCHITECTURE.md`'s
"In-CLI coding agent" section.

### Diagnostics & cleanup

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
