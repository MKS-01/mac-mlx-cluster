---
name: debug
description: Use when the cluster or mlx-cluster-cli is misbehaving — model won't load, "server unreachable", chat hangs or errors, wrong Mac is serving, or stats show unavailable. Runs a layered diagnostic from the physical link up through the CLI's own config/prefs files. Triggers on "the cluster isn't working", "server won't start", "can't connect", "why is it running on the wrong Mac".
---

Diagnose top-down, in this order — each layer's failure explains everything
above it, so don't skip ahead. Read config first so the rest of the checks
use real IPs instead of guessing.

## 0. Read the CLI's actual config

```sh
CFG=~/.mlx/cluster-cli.json
test -f "$CFG" && python3 -c "
import json
c = json.load(open('$CFG'))
print('server:', c['server']['ip'], c['server']['sshUser'], 'api:', c['server'].get('apiPort'), 'macmon:', c['server'].get('macmonPort'))
print('peer:  ', c['peer']['ip'], c['peer']['sshUser'], 'macmon:', c['peer'].get('macmonPort'))
print('model: ', c.get('defaultModel'))
" || echo "MISSING — CLI silently falls back to hardcoded defaults 10.0.0.1/10.0.0.2, which may be wrong for this machine"
```

If the file is missing, that alone can explain "talking to the wrong Mac" —
per `CLAUDE.md`, a missing config file does not fail loudly.

Also sanity-check prefs aren't corrupt (a bad one falls back to defaults
silently rather than crashing, per `src/cli/src/config/prefs.ts`):

```sh
python3 -m json.tool ~/.mlx/cluster-cli-prefs.json >/dev/null && echo prefs-ok
```

## 1. Physical link

```sh
ifconfig bridge0 | grep status   # want: status: active
```
Not active → check the Thunderbolt cable and both Macs are awake.

## 2. IP reachability (use IPs from step 0)

```sh
ping -c 2 <server-ip>
ping -c 2 <peer-ip>
```
~1-2ms expected over TB4. Timeouts with bridge active → static IP was lost
(reboot resets it unless persisted) — re-run `networksetup -setmanual`
from `doc/CLUSTER_SETUP.md` §2.

## 3. SSH (both directions, matching the CLI's own options)

```sh
ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
  <sshUser>@<server-ip> hostname
```
Common failures and what they mean (from `src/cli/src/net/ssh.ts`'s
`describeSshFailure`):
- **timeout** → bridge down or that Mac asleep
- **"Permission denied"** → key not authorized on that node — see
  `CLUSTER_SETUP.md` §3
- **"Could not resolve hostname" / "No route to host"** → wrong IP or
  bridge not connected

## 4. Is the model server actually up?

```sh
curl -s -m 5 http://<server-ip>:8080/v1/models
```
No response → check the LaunchAgent:
```sh
ssh <sshUser>@<server-ip> 'launchctl print gui/$(id -u)/com.mlx-server' | head -20
ssh <sshUser>@<server-ip> 'tail -50 ~/Library/Logs/mlx-server.log'
```
Look in the log for an offline-cache miss (`HF_HUB_OFFLINE=1` means an
uncached model repo fails to load rather than downloading) or a port
conflict.

## 5. Is the wrong Mac serving?

Wear-leveling (`src/cli/src/cluster/splitPolicy.ts`) can legitimately move
serving to the peer. Check `~/.mlx/cluster-cli-prefs.json`'s split target
and accumulated history, and whether `session.tookOverFromServer` logic
applies (see `doc/ARCHITECTURE.md`'s "Wear-leveling split" section) before
assuming it's a bug.

## 6. macmon (stats bar shows "unavailable")

```sh
curl -s -m 3 http://<server-ip>:9090/metrics | head -5
curl -s -m 3 http://<peer-ip>:9090/metrics | head -5
```
No response on a node → `macmon serve --install` may not be running there;
`StatsBar` degrades gracefully but won't show that node's numbers.

## 7. HF cache / model issues

```sh
mlxctl list          # true size + complete/incomplete, unlike `hf cache list`
mlxctl status <repo>
```
See the `cleanup` skill if this turns up stale locks or incomplete
downloads, or `model-fit` if the issue is "does this model even fit".

## 8. Chat streams but returns empty / cuts off

Reasoning models can exhaust `max_tokens` on internal thinking before any
real content streams (`finish_reason: "length"` with zero content chunks)
— this is a known, handled case in `src/cli/src/chat/chat.ts`, not a bug;
raise `max_tokens` or check the CLI's own error message, which should name
this explicitly rather than show a blank reply.
