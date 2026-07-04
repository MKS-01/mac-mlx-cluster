# mlx-cluster-cli

Terminal chat client + lifecycle manager for the two-Mac MLX cluster
(see [`../cluster/CLUSTER_SETUP.md`](../cluster/CLUSTER_SETUP.md) and
[`../cluster/CLI_PLAN.md`](../cluster/CLI_PLAN.md)). Bun + TypeScript + Ink,
built following the same shell/lifecycle pattern as `readback-cli`.

## What it does

- Health-checks the M1's `mlx_lm.server` LaunchAgent over the Thunderbolt
  bridge (**cluster mode**). If it's already running, attaches to it without
  touching its lifecycle (could be another session's). If it's not running
  but SSH works, starts it (`launchctl bootstrap`/`kickstart`) and owns
  it for the session — stopped (`launchctl bootout`) on quit, freeing the
  M1's RAM. Either way chat talks to the M1.
- If the M1 is unreachable by both HTTP and SSH (asleep, unplugged, bridge
  down), spawns `mlx_lm.server` locally on whichever Mac the CLI is running
  on (**local mode**) and owns that process for the session — killed on quit.
- Full multi-turn streaming chat against the served model.
- `/model <repo>` to switch models without restarting the CLI (cluster mode:
  edits the remote LaunchAgent plist + `launchctl kickstart -k`; local mode:
  respawns the local process).
- Live stats bar (CPU/GPU/temp/RAM), combined or per-node (`/stats` to
  toggle), via `macmon serve` polled over HTTP on both Macs.

## Setup

1. Everything in `CLUSTER_SETUP.md` — bridge IPs, SSH keys, the M1's
   `mlx_lm.server` LaunchAgent — must already be working.
2. Install `macmon` and register it as a login service **on both Macs**:
   ```sh
   brew install macmon
   macmon serve --install    # installs its own launchd service, port 9090
   ```
3. Copy [`config.example.json`](./config.example.json) to
   `~/.mlx/cluster-cli.json` and fill in your usernames/IPs (defaults match
   `CLUSTER_SETUP.md`'s example — 10.0.0.1 server / 10.0.0.2 peer — so if
   you followed that guide as-is you may not need to change much).
4. `bun install`

## Run

```sh
bun run start                    # dev, from source
./install.sh                     # or: build + install standalone binary
mlx-cluster-cli                  # after install.sh, from anywhere
mlx-cluster-cli --model <repo>   # override the default/last-used model
```

## Commands

| Command | What |
|---|---|
| `/model` | show current model |
| `/model <repo>` | switch the served model |
| `/stats` | toggle combined ↔ per-node stats view |
| `/clear` | clear the chat transcript |
| `/help` | toggle command help |
| `/quit`, `/exit`, `q` | quit |

`Esc` cancels an in-flight generation without quitting. `Ctrl+C` quits.

## Error handling

Every network/SSH call is wrapped with a timeout and a specific message
rather than a stack trace or hang:

- **Bridge down / M1 asleep** → falls back to local mode automatically.
- **M1 reachable via SSH but its server isn't running** → CLI starts it
  itself; if that fails (or times out waiting for it to come up), falls
  back to local mode rather than hanging.
- **SSH unreachable/unauthorized** → `/model` in cluster mode reports it
  can't reach the node rather than hanging; chat itself doesn't need SSH.
- **Abnormal exit (crash, uncaught error)** → a synchronous best-effort
  SSH bootout still runs from the process `exit`/`uncaughtException`
  handlers, so a session that started the M1's server doesn't orphan it
  even if the normal quit path is skipped.
- **macmon down on a node** → that node's line in the stats bar shows
  "unavailable" instead of crashing the UI.
- **Local venv/mlx_lm.server missing** → clear one-line error, exits non-zero
  before Ink even renders.
- **Port already in use for local fallback** → clear error instead of a
  silent hang; won't clobber another running server.
- **Model switch fails or times out** → old session state is preserved
  (never silently left "switched" if the new model didn't actually load).
- **Server crashes mid-stream** → chat error shown inline, session stays
  alive, you can retry or switch models.
- **Corrupt prefs/config JSON** → config errors are fatal with a clear
  message (fix or delete the file); prefs errors silently fall back to
  defaults (never crash on a cosmetic file).
