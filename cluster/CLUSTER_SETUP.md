# Two-Mac MLX cluster setup (Thunderbolt, ring backend)

Step-by-step record of connecting two Macs over a Thunderbolt cable and running
distributed MLX jobs across them with `mlx.launch`. Verified working on an
M5 Pro (48 GB) + M1 Pro (32 GB) over Thunderbolt 4.

Based on the workflow from [WWDC 2026 session 233](https://developer.apple.com/videos/play/wwdc2026/233/),
adapted for Thunderbolt 4 (see [Backend choice](#backend-choice-ring-not-jaccl)).

Throughout, **node A** is the Mac you launch from (rank 0) and **node B** is the
other Mac (rank 1). Adjust usernames/IPs to your machines, and run the command
blocks **from the repo root** (paths like `cluster/ring_test.py` are
repo-relative).

## 1. Physical link

Connect the Macs with a Thunderbolt cable. macOS creates a **Thunderbolt Bridge**
interface (`bridge0`) automatically. Verify the link is active:

```sh
ifconfig bridge0 | grep status    # want: status: active
```

## 2. Static IPs on the bridge

By default the bridge self-assigns a 169.254.x.x address. Give each Mac a fixed
IP so the hostfile stays stable:

```sh
# on node A (rank 0)
sudo networksetup -setmanual "Thunderbolt Bridge" 10.0.0.2 255.255.255.0
# on node B (rank 1)
sudo networksetup -setmanual "Thunderbolt Bridge" 10.0.0.1 255.255.255.0
```

Verify: `ping -c 2 10.0.0.1` from node A (expect ~1–2 ms over TB4).

## 3. SSH everywhere (including to yourself)

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

## 4. MLX on both Macs

Each node needs its own MLX venv, **with matching `mlx` versions**:

```sh
python3 -m venv ~/.venvs/mlx
~/.venvs/mlx/bin/pip install mlx mlx-lm
~/.venvs/mlx/bin/python -c "import mlx.core as mx; print(mx.__version__)"
```

Everything below assumes the venv lives at `~/.venvs/mlx` on both machines.

## 5. Hostfile

Copy [`hostfile.example.json`](./hostfile.example.json) to `~/.mlx/tb-ring-hostfile.json`
and edit the user/IPs. The first entry is rank 0:

```json
[
  {"ssh": "<user>@10.0.0.2", "ips": ["10.0.0.2"]},
  {"ssh": "<user>@10.0.0.1", "ips": ["10.0.0.1"]}
]
```

## 6. Smoke test

`mlx.launch` does **not** copy your script — it must exist at the same absolute
path on every node. Put shared scripts somewhere identical on both Macs
(e.g. `~/.mlx/`):

```sh
mkdir -p ~/.mlx && cp cluster/ring_test.py ~/.mlx/
ssh <user>@10.0.0.1 'mkdir -p ~/.mlx'
scp cluster/ring_test.py <user>@10.0.0.1:.mlx/

mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
    --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/ring_test.py"
```

Expected output — each rank reports the sum over both nodes:

```
rank 0/2 all_sum -> [2.0, 2.0, 2.0, 2.0]
rank 1/2 all_sum -> [2.0, 2.0, 2.0, 2.0]
```

## 7. Distributed inference (sharding a model across both Macs)

Only worth it for models too big for one Mac — sharding aggregates memory, not
speed. Two modes, chosen per model architecture:

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

For a scripted test, use [`tp_test.py`](./tp_test.py) (uses the `sharded_load`
API and prints each rank's memory + tok/s; copy it to `~/.mlx/` on both nodes
first):

```sh
mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
    --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/tp_test.py" [model-repo]
```

**Measured** (Qwen3.6-35B-A3B-4bit-DWQ, ~19 GB, tensor parallel over TB4):
each rank held 10.9 GB of weights — half the model per Mac — generating at
~9.6 tok/s. Note this model **fits on one Mac** and was chosen only to smoke-test
the mechanism; for real use it belongs on a single node as a server (§8), where
it runs 3–4× faster. Shard only what one Mac can't hold.

## 8. Dedicated model server (LaunchAgent)

If the model fits on one Mac, don't shard — run it whole on the "server" Mac
and keep the other machine's memory 100% free. Tensor parallelism can't do
uneven splits (55/45, 60/40): ranks always get equal shares, model dims must
divide by the rank count, and stacking multiple ranks on one GPU to fake a
ratio caused Metal GPU timeouts on the M1. Pattern A is the better answer.

Install [`mlx-server.example.plist`](./mlx-server.example.plist) on the server
Mac — **first edit the file**: replace `USERNAME` (3 places) and set your model
and bind IP/port. Then:

```sh
# edit cluster/mlx-server.example.plist before copying!
ssh <user>@10.0.0.1 'mkdir -p ~/Library/LaunchAgents'
scp cluster/mlx-server.example.plist <user>@10.0.0.1:Library/LaunchAgents/com.mlx-server.plist
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
or chat interactively with the zero-dependency client in this repo:

```sh
python3 cluster/chat.py                # default server http://10.0.0.1:8080
python3 cluster/chat.py --url http://localhost:8080   # or set $MLX_SERVER_URL
```

## Backend choice: ring, not jaccl

The WWDC demo uses `--backend jaccl` (RDMA over Thunderbolt 5). JACCL requires
TB5 on **every** node; on a TB4 machine use the default TCP `ring` backend over
the bridge IPs instead. Same hostfile shape, just no `"rdma"` entries.

## Gotchas we hit

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
