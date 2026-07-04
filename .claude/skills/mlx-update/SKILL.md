---
name: mlx-update
description: Use to check for and apply updates to `mlx`/`mlx-lm` from https://github.com/ml-explore/mlx, on one Mac or kept in sync across both. Triggers on "update mlx", "is there a new mlx version", "sync mlx between the Macs", "check for mlx updates".
---

## Why this needs its own checklist, not just `pip install --upgrade`

`CLUSTER_SETUP.md`'s gotchas call out **version skew** explicitly: `mlx`
must be the *same* version on every node, or distributed jobs (`mlx.launch`)
can fail or misbehave in ways that look like a networking problem instead of
a version mismatch. A bare upgrade on just the Mac you're sitting at silently
creates that skew if this is the two-Mac cluster. Always check both nodes
when the cluster is set up, even if only one Mac prompted the check.

## Step 1 — check current vs. latest

```sh
~/.venvs/mlx/bin/python -c "import mlx.core as mx; print(mx.__version__)"
~/.venvs/mlx/bin/pip show mlx-lm | grep -i version
~/.venvs/mlx/bin/pip list --outdated 2>/dev/null | grep -E "^(mlx|mlx-lm)\b"
```

If you want to know *what's new* before upgrading (not just that a newer
version exists), check the release notes rather than guessing from the
version number:

```sh
gh api repos/ml-explore/mlx/releases/latest --jq '.tag_name, .body' 2>/dev/null
```

(or `WebFetch` on `https://github.com/ml-explore/mlx/releases` if `gh` isn't
authenticated). Skim for anything relevant to this repo: API changes to
`mx.distributed`, `sharded_load`, `mlx.launch` flags, or `mx.device_info()`
fields — `src/tools/dist_bench.py`, `src/tools/mlxctl`'s `meminfo`, and
`mlx-cluster-cli`'s distributed launch code all depend on those staying
stable.

## Step 2 — check if this Mac is part of the cluster

```sh
cat ~/.mlx/cluster-cli.json 2>/dev/null | grep -E '"ip"|"sshUser"'
```

If it is, you have two Macs to keep in lockstep. If not (standalone
single-Mac use), skip straight to Step 3 and stop after it.

## Step 3 — upgrade

On this Mac:

```sh
~/.venvs/mlx/bin/pip install --upgrade mlx mlx-lm
~/.venvs/mlx/bin/python -c "import mlx.core as mx; print(mx.__version__)"
```

If clustered, do the same on the other node over SSH so both land on the
*exact* same version — don't let one Mac drift ahead:

```sh
ssh <user>@<other-ip> '~/.venvs/mlx/bin/pip install --upgrade mlx mlx-lm && \
  ~/.venvs/mlx/bin/python -c "import mlx.core as mx; print(mx.__version__)"'
```

Compare the two printed versions before moving on — they must match exactly.

## Step 4 — restart anything already running the old build

An already-running `mlx_lm.server` process keeps the old version loaded in
memory until restarted — upgrading the venv doesn't affect it live.

```sh
mlxctl server status                 # or: launchctl print gui/$(id -u)/com.mlx-server
mlxctl server stop && mlxctl server start
```

If a wired-memory LaunchDaemon or any `mlx.launch` job is mid-run, let it
finish or stop it first — don't upgrade packages out from under a live
distributed job.

## Step 5 — sanity check

```sh
mlx_lm.chat --model <a small cached repo> --max-tokens 16
```

If clustered and either node changed, also re-run the smoke test
(`doc/CLUSTER_SETUP.md` §6) before trusting distributed jobs again:

```sh
mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
    --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/dist_bench.py"
```
