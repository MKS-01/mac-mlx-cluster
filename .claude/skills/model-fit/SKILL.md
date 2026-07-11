---
name: model-fit
description: Use before downloading or running a model to check whether a given Hugging Face repo (at a given quant) will actually fit in RAM on the M1 Pro (32GB) or M5 Pro (48GB), and to recommend which Mac (or whether sharding) it needs. Triggers on "will this model fit", "which Mac should serve this", "should I download the 6bit or 8bit", "is this too big for one Mac".
---

## Prefer real numbers over rules of thumb

`mlxctl meminfo` reads the exact values MLX itself uses on that Mac —
`mx.device_info()`'s `max_recommended_working_set_size` and the live
`iogpu.wired_limit_mb` sysctl — rather than guessing from a RAM-minus-slack
heuristic. Use it whenever the model is already cached on the Mac you're
checking. See `doc/ARCHITECTURE.md`'s "Wired-memory limit" section and
`doc/CLUSTER_SETUP.md` §9 for how MLX's automatic per-generation wiring and
the OS-level ceiling relate.

## Step 1 — get the model's real weight size

**If it's already cached (on the Mac in question):**
```sh
mlxctl meminfo <repo>     # exact fit verdict: comfortably fits / near the wired-limit ceiling / exceeds it
```
This mirrors mlx-lm's own 90%-of-ceiling warning threshold, so a "near the
ceiling" verdict here means the server log will show the same
`[WARNING] Generating with a model that requires...` mlx-lm prints itself.

Run `mlxctl meminfo` with no repo first to see the Mac's totals (RAM, max
recommended working set, current OS wired limit) before or alongside the
per-repo check.

**If it's not cached anywhere yet**, sum the actual safetensor file sizes
from the Hub without downloading:
```sh
python3 -c "
from huggingface_hub import HfApi
info = HfApi().model_info('<org>/<repo>', files_metadata=True)
total = sum(f.size for f in info.siblings if f.rfilename.endswith(('.safetensors', '.bin', '.gguf')) and f.size)
print(f'{total/1e9:.1f} GB')
"
```
(Run from the MLX venv — `~/.venvs/mlx/bin/python`.) Compare this size
against `mlxctl meminfo`'s (repo-less) totals for each candidate Mac by
hand, since the model isn't cached there yet for `mlxctl meminfo <repo>`
to check directly.

## Step 2 — decide where it serves

- **Fits comfortably on a Mac** (per `mlxctl meminfo`, or well under its
  max recommended working set if not yet downloaded) → serve it whole
  there (Pattern A). Prefer the M1 (server) if it fits, to keep the M5
  free for dev work — that's the existing default.
- **Only fits the M5, not the M1** → serve on M5 instead (edit
  `~/.mlx/cluster-cli.json`'s note of which node is "server", or just run
  locally on the M5 — see `CLAUDE.md`'s Pattern A).
- **Exceeds both Macs' working sets** → candidate for Pattern B
  (tensor-parallel sharding across both Macs — see
  `doc/CLUSTER_SETUP.md` §7). Confirm the architecture actually supports
  sharding (has a `shard` method in `mlx_lm` — true for most models
  including Qwen3.6 MoE) before recommending it; pipeline mode
  (`--pipeline`) only works for architectures whose model class
  implements `pipeline()`.
- Sharding **aggregates memory, not speed** — never recommend it for a
  model that already fits on one Mac; that makes it slower for no benefit.
- **"Near the ceiling" verdict on the intended Mac** → before ruling it
  out, check whether `iogpu.wired_limit_mb` is actually raised there
  (`mlxctl meminfo`'s totals output shows it) — a low/unset OS wired limit
  can make an otherwise-fitting model look tight. See
  `doc/CLUSTER_SETUP.md` §9 to raise and persist it.

## Step 3 — quant/architecture guidance (per `CLAUDE.md`)

- Prefer the newest Qwen generation available (3.6 > 3.5).
- Rough weight-size-per-bit-depth at a ~48GB-class model total parameter
  count: 4bit ≈ 15 GB, 6bit ≈ 21 GB, 8bit ≈ 28 GB, `bf16` doesn't fit —
  scale proportionally for other parameter counts (bytes ≈ params ×
  bits/8 × ~1.05 overhead).
- `-DWQ` 4-bit gives better quality than plain 4-bit at the same size —
  prefer it when both are available.
- MoE variants (`-A3B`) run faster than a dense model of similar total
  size — prefer MoE when choosing between architectures of similar
  weight footprint.

## Output format

State plainly: exact size found, which node(s) it fits on with headroom
remaining, and the one recommended action (serve on M1 / serve on M5 /
shard across both / download a smaller quant instead).
