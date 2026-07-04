---
name: cleanup
description: Use for general housekeeping across this repo and its environment - stale hf-download locks, incomplete/partial model downloads, orphaned hf-download or mlx_lm.server processes, and repo hygiene (nothing personal/secret slipping into git, given the private-now/open-source-later release plan). Triggers on "clean up the cache", "is anything stuck downloading", "check the repo is clean before pushing", "find orphaned processes".
---

Three independent areas — run whichever the user's actually asking about,
or all three for a general tidy.

## 1. HF cache / download state

```sh
mlxctl list                     # true size + status; counts .incomplete, unlike `hf cache list`
mlxctl clean                    # no repo arg = global tidy: clears stale locks, reports incompletes, doesn't kill anything
```
For a specific stuck repo:
```sh
mlxctl clean <repo>             # kills its `hf download` process + removes partial + locks for just that repo
```
**Never** manually `rm -rf` inside `~/.cache/huggingface/hub/.locks/` or a
`models--*` dir while a download might be running elsewhere — always go
through `mlxctl clean` so the right process gets killed first. Two
concurrent `hf download` runs of the same model deadlock on the cache
lock; `mlxctl clean <repo>` is the documented way out (see `CLAUDE.md`
"Download gotchas").

## 2. Orphaned processes

```sh
pgrep -fl "hf download"
pgrep -fl "mlx_lm.server"
```
Before killing an `mlx_lm.server` match: check whether it's the M1's
LaunchAgent-managed instance (`launchctl print
gui/$(id -u)/com.mlx-server` on that Mac) — that one should be stopped via
`launchctl bootout`, not `kill`, or launchd will just restart it (or the
CLI's crash-safety re-bootstrap logic will interfere). Only `kill` a
`mlx_lm.server` you're sure was hand-launched (e.g. local-fallback mode
left running after a crashed CLI session).

## 3. Repo hygiene (this repo specifically is pre-open-source)

`CLAUDE.md`: "Release plan: private now, open-sourced later. Keep secrets
and personal absolute paths out of committed files." Before any commit or
push, especially of config-shaped files:

```sh
git status --ignored --short   # confirm .idea/, .DS_Store, node_modules/, dist/ stay untracked
git ls-files | grep -E 'cluster-cli\.json$|hostfile\.json$'   # should be EMPTY — only the .example variants belong in git
```
If either of those greps returns a hit, that's a real config file with
IPs/usernames that got committed by mistake — flag it, don't just add it
to `.gitignore` after the fact (it's already in history at that point;
that needs the user's explicit call on how to handle it).

```sh
git diff --cached --name-only | xargs grep -lE '/Users/[a-zA-Z0-9_-]+' 2>/dev/null
```
Catches personal absolute paths accidentally hardcoded into a staged
file (should be `~` or a config value instead).

## Don't do as part of "cleanup"

- Don't delete cached models just because they're large — that's a
  `mlxctl remove <repo>` decision for the user to make, not an automatic
  cleanup action.
- Don't touch `src/cluster/hostfile.json` (gitignored, real IPs) — only
  the checked-in `.example` files are repo content.
