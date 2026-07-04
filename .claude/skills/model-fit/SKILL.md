---
name: model-fit
description: Use before downloading or running a model to check whether a given Hugging Face repo (at a given quant) will actually fit in RAM on the M1 Pro (32GB) or M5 Pro (48GB), and to recommend which Mac (or whether sharding) it needs. Triggers on "will this model fit", "which Mac should serve this", "should I download the 6bit or 8bit", "is this too big for one Mac".
---

## Budget, not just RAM total

Leave headroom for macOS + the MLX runtime + KV cache growth during
generation — don't compare against the full RAM figure.

| Node | RAM | Usable budget (rule of thumb: RAM − 6GB) |
|---|---|---|
| M1 Pro (server) | 32 GB | ~26 GB |
| M5 Pro (peer/dev) | 48 GB | ~42 GB |

## Step 1 — get the model's real weight size

**If it's already (partially) cached:**
```sh
mlxctl status <repo>     # exact on-disk size, incomplete-aware
```

**If it's not cached yet**, sum the actual safetensor file sizes from the
Hub without downloading:
```sh
python3 -c "
from huggingface_hub import HfApi
info = HfApi().model_info('<org>/<repo>', files_metadata=True)
total = sum(f.size for f in info.siblings if f.rfilename.endswith(('.safetensors', '.bin', '.gguf')) and f.size)
print(f'{total/1e9:.1f} GB')
"
```
(Run from the MLX venv — `~/.venvs/mlx/bin/python`.)

## Step 2 — compare against budget

- Weight size **fits** a node's usable budget → serve it whole there
  (Pattern A). Prefer the M1 (server) if it fits, to keep the M5 free for
  dev work — that's the existing default.
- Weight size **only fits the M5's budget, not the M1's** → serve on M5
  instead (edit `~/.mlx/cluster-cli.json`'s note of which node is
  "server", or just run locally on the M5 — see `CLAUDE.md`'s Pattern A).
- Weight size **exceeds even the M5's budget (>~38-42 GB)** → candidate
  for Pattern B (tensor-parallel sharding across both Macs — see
  `doc/CLUSTER_SETUP.md` §7). Confirm the architecture actually supports
  sharding (has a `shard` method in `mlx_lm` — true for most models
  including Qwen3.6 MoE) before recommending it; pipeline mode
  (`--pipeline`) only works for architectures whose model class
  implements `pipeline()`.
- Sharding **aggregates memory, not speed** — never recommend it for a
  model that already fits on one Mac; that makes it slower for no benefit.

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
