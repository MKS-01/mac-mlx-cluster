---
name: ssh-check
description: Use to verify or troubleshoot Thunderbolt-bridge SSH connectivity between the two cluster Macs — bridge link state, static IPs, key-based auth in both directions including self-SSH (required by mlx.launch). Triggers on "set up SSH between the Macs", "ssh isn't working", "mlx.launch can't reach a rank", "host key verification failed".
---

Checks mirror exactly what `doc/CLUSTER_SETUP.md` §1-3 sets up and what
`src/cli/src/net/ssh.ts` relies on at runtime (`BatchMode=yes`,
`ConnectTimeout=5`, `StrictHostKeyChecking=accept-new` — never an
interactive password/host-key prompt).

## 1. Bridge link

```sh
ifconfig bridge0 | grep status   # want: status: active
```

## 2. Static IPs

Get the expected IPs from the CLI config if set up already:
```sh
python3 -c "
import json
c = json.load(open('$HOME/.mlx/cluster-cli.json'))
print('server:', c['server']['ip']); print('peer:', c['peer']['ip'])
" 2>/dev/null || echo "no cluster-cli.json — use the IPs from CLUSTER_SETUP.md (default 10.0.0.1 / 10.0.0.2)"
```
```sh
ping -c 2 <server-ip>
ping -c 2 <peer-ip>
```
Expect ~1-2ms over TB4. If either fails, re-set with:
```sh
sudo networksetup -setmanual "Thunderbolt Bridge" <this-machine-ip> 255.255.255.0
```

## 3. Key-based auth — all four directions matter

`mlx.launch` SSHes into **every** rank, including the machine it's run
from — so self-SSH must work too, not just cross-machine.

```sh
# from node A: A→B, A→A (self)
ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new <user>@<B-ip> hostname
ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new <user>@<A-ip> hostname
```
Run the matching pair from node B too (B→A, B→B) if setting up for the
first time or diagnosing `mlx.launch` rank failures specifically.

If a check hangs or prompts instead of returning immediately, the flags
above are being ignored — that means Remote Login isn't enabled on the
target, or the command is being run without `-o BatchMode=yes` somewhere
in the actual failing path (find and fix that call rather than adding a
password fallback).

## Common failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `Connection refused` | Remote Login off | System Settings → Sharing → Remote Login on that Mac (or `sudo systemsetup -setremotelogin on`) |
| `Permission denied (publickey...)` | key not authorized on target | `ssh-copy-id <user>@<ip>`; for self-SSH: `cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys` |
| Hangs / "Host key verification failed" without `accept-new` | first-contact host key not recorded | the `accept-new` flag (already in every check above) fixes this — if you're running a bare `ssh` without it, that's the bug |
| Times out (no response at all) | bridge down, target asleep, or wrong IP | re-check step 1-2 |
| Works from A→B but not B→A | keys only copied one direction | repeat `ssh-copy-id` from B, and for self-SSH, on B too |

## After this passes

If this was prep for a fresh cluster setup, continue to
`doc/CLUSTER_SETUP.md` §4 (MLX venvs) and §5 (hostfile). If this was
triage for a broken CLI/cluster session, cross-reference with the `debug`
skill — SSH failing explains most of the CLI's cluster-mode fallback
messages (`src/cli/src/net/ssh.ts`'s `describeSshFailure`).
