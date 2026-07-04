"""Distributed MLX smoke test + benchmark: verifies the mlx.launch group
works (all_sum across every rank), then — if a model repo is given — shards
it across the cluster, generates one response, and reports memory + tok/s.

Must run under mlx.launch (plain `python dist_bench.py` only sees one rank).
For the tensor-parallel benchmark, copy this file to the same path on every
node first.

Run with:
    # smoke test only — verifies the group, no model needed
    mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
        --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/dist_bench.py"

    # + tensor-parallel benchmark — shards the model, reports memory + tok/s
    mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
        --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/dist_bench.py" [model-repo]
"""

import sys

import mlx.core as mx

group = mx.distributed.init()
rank, size = group.rank(), group.size()

# Smoke test: every rank contributes ones, all_sum should equal world size.
x = mx.distributed.all_sum(mx.ones(4))
mx.eval(x)
print(f"rank {rank}/{size} all_sum -> {x.tolist()}", flush=True)

if len(sys.argv) <= 1:
    sys.exit(0)  # smoke test only — no model given, nothing further to do

from mlx_lm.generate import stream_generate
from mlx_lm.utils import sharded_load

model_repo = sys.argv[1]
model, tokenizer = sharded_load(model_repo, tensor_group=group)
mx.eval(model.parameters())
print(
    f"[rank {rank}/{size}] weights loaded, GPU memory: "
    f"{mx.get_active_memory() / 1e9:.1f} GB",
    flush=True,
)

prompt = tokenizer.apply_chat_template(
    [{"role": "user", "content": "In one sentence, why is the sky blue?"}],
    add_generation_prompt=True,
)

chunks = []
resp = None
for resp in stream_generate(model, tokenizer, prompt, max_tokens=100):
    chunks.append(resp.text)
if rank == 0 and resp is not None:
    print(f"\nANSWER: {''.join(chunks).strip()}", flush=True)
    print(
        f"\n{resp.generation_tokens} tokens ({resp.generation_tps:.1f} tok/s)",
        flush=True,
    )
print(
    f"[rank {rank}/{size}] peak GPU memory: {mx.get_peak_memory() / 1e9:.1f} GB",
    flush=True,
)
