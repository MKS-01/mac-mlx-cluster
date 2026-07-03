# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is a docs + tooling repo for Mac cluster setup and experimentation with MLX LLMs on Apple Silicon and across a two-Mac cluster. No build/test/lint — it holds guides (`MLX_QUICKSTART.md`, `cluster/CLUSTER_SETUP.md`) and the `mlxctl` CLI.

**Release plan: private now, open-sourced later.** Keep secrets and personal absolute paths out of committed files (or isolate them so they're easy to scrub). Write docs and `mlxctl` for an eventual public audience.

## Environment (not in this repo)

- **MLX lives in a venv at `~/.venvs/mlx`** (Python 3.12), NOT in this directory. All `mlx_lm.*`, `hf`, and `mlxctl` commands come from `~/.venvs/mlx/bin`, which is on PATH via `~/.zshenv`. In already-open shells run `source ~/.zshenv` first.
- **Models are cached in `~/.cache/huggingface/hub`**, shared by all tools. They are NOT stored in this repo.

## `mlxctl` — the model manager

`mlxctl` (in this repo, symlinked into `~/.venvs/mlx/bin`) manages cached models with incomplete-aware status. Edit the file here; the symlink picks up changes.

- `mlxctl list` — all models with true size + status (counts `.incomplete`, unlike `hf cache list`)
- `mlxctl status <repo>` — per-shard download progress
- `mlxctl download <repo>` — refuses to start if one is already running
- `mlxctl remove <repo>` / `mlxctl clean [repo]` — delete / kill+clear locks+partials
- `mlxctl run <repo> [args]` — launch `mlx_lm.chat` (repo accepts a unique substring, e.g. `9b`)

## Download gotchas (we hit these)

- **Never `Ctrl+C` a download.** The `hf-xet` backend starts a fresh temp file per attempt instead of resuming, so interrupting effectively restarts that shard from 0.
- **Only one download at a time.** Two `hf download` runs of the same model deadlock on the HF cache lock (`.locks/...`). Use `mlxctl clean <repo>` to kill stragglers + clear stale locks.
- `hf cache list` only counts completed files — use `mlxctl list`/`status` to see in-progress size.

## Hardware patterns (see `cluster/CLUSTER_SETUP.md`)

Two Macs: **M1 Pro 32 GB (Thunderbolt 4)** + **M5 Pro 48 GB**.
- **The cluster is set up and working.** `cluster/CLUSTER_SETUP.md` is the verified, authoritative walkthrough (IPs, hostfile location, launch commands, gotchas).
- **Pattern A (default, running):** the M1 Pro serves a model via `mlx_lm.server` as a LaunchAgent; dev on the M5 Pro via the API. No clustering.
- **Pattern B:** shard across both Macs over Thunderbolt only for models too big for one Mac (>~38 GB). Sharding mode is dictated by the model: tensor parallel is the default (verified working); `--pipeline` only for architectures that implement it (Qwen3.6 MoE does not).
- Sharding aggregates **memory, not speed** — clustering a model that fits on one Mac makes it slower. RDMA/JACCL speedups need Thunderbolt 5, which the M1 Pro lacks.

## Model selection

Prefer the newest Qwen (3.6 > 3.5). For 48 GB: 4bit ≈ 15 GB, 6bit ≈ 21 GB, 8bit ≈ 28 GB; `bf16` won't fit. `-DWQ` 4-bit gives better quality than plain 4-bit at the same size. MoE models (`-A3B`) run faster than dense models of similar total size.
