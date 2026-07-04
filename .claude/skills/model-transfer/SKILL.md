---
name: model-transfer
description: Use to copy an already-downloaded model from one Mac's Hugging Face cache to the other over the Thunderbolt bridge, so both nodes have it cached without re-downloading twice. Needed before tensor-parallel sharding (the snapshot must exist on every node) or before switching which Mac acts as the Pattern A server. Triggers on "copy this model to the other Mac", "get this model onto the M1/M5 too", "sync the cache".
---

## Why not just re-download

Two independent `hf download` runs of the same repo on different Macs work
fine (they're different machines, no shared lock) — but it's slower and
wastes bandwidth/time versus a direct Thunderbolt transfer of a snapshot
that's already complete on one side. Only transfer models that are
**complete** on the source — check first:

```sh
mlxctl status <repo>   # on the source Mac; confirm "complete", not incomplete/partial
```

## Get the target's IP/user from the CLI's own config

```sh
python3 -c "
import json
c = json.load(open('$HOME/.mlx/cluster-cli.json'))
print(c['server']['sshUser'] + '@' + c['server']['ip'], '(server)')
print(c['peer']['sshUser'] + '@' + c['peer']['ip'], '(peer)')
"
```

## Transfer

The repo dir name uses `--` in place of `/`, e.g.
`mlx-community/Qwen3.6-35B-A3B-4bit-DWQ` →
`models--mlx-community--Qwen3.6-35B-A3B-4bit-DWQ`.

```sh
REPO_DIR="models--<org>--<repo-with-dashes>"
TARGET="<user>@<target-ip>"

# mkdir matters: macOS's bundled rsync will NOT create missing parent dirs
ssh "$TARGET" 'mkdir -p ~/.cache/huggingface/hub'

rsync -a --info=progress2 \
  ~/.cache/huggingface/hub/"$REPO_DIR" \
  "$TARGET":.cache/huggingface/hub/
```

Only copy the specific `models--org--repo` directory — never rsync the
whole `hub/` tree (drags over unrelated models, and copying `.locks/` can
create stale lock files on the target for downloads that aren't actually
in progress there).

## Verify on the target

```sh
ssh "$TARGET" "cd ~ && python3 -c \"
import sys; sys.path.insert(0, '.venvs/mlx/lib/python3.12/site-packages')
\"" 2>/dev/null  # (usually unnecessary — mlxctl reads the cache dir directly)

ssh "$TARGET" '~/.venvs/mlx/bin/python /path/to/mlxctl status <repo>' \
  2>/dev/null || echo "mlxctl not present on target — copy src/mlxctl over or just confirm the directory landed:"
ssh "$TARGET" "du -sh ~/.cache/huggingface/hub/$REPO_DIR"
```

`mlxctl` treats the cache directory as ground truth (no separate manifest
to update), so once the directory + blobs exist on the target, `mlxctl
list`/`status` run there will pick it up immediately — no registration
step needed.

## After transfer

- If this was prep for sharding: continue with `doc/CLUSTER_SETUP.md` §7
  (`mlx.launch --hostfile ... --backend ring`).
- If this was to move Pattern A serving to the other Mac: update
  `~/.mlx/cluster-cli.json` if the "server" role is changing permanently,
  or just point `mlx_lm.server`/the LaunchAgent plist at the new node —
  see the `debug` skill if the switch doesn't come up cleanly.
