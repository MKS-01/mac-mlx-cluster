"""Tensor-parallel test: shard a model across the cluster, generate, report memory + tok/s.

Must run under mlx.launch (plain `python tp_test.py` loads the whole model on one node).
Copy to the same path on every node first, then:

    mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
        --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/tp_test.py" [model-repo]
"""

import sys

import mlx.core as mx
from mlx_lm.generate import stream_generate
from mlx_lm.utils import sharded_load

DEFAULT_MODEL = "mlx-community/Qwen3.6-35B-A3B-4bit-DWQ"

group = mx.distributed.init()
rank, size = group.rank(), group.size()

model_repo = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL
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
