"""Cluster smoke test: each rank contributes ones, all_sum should equal world size.

Run with:
    mlx.launch --hostfile ~/.mlx/tb-ring-hostfile.json --backend ring \
        --python "$HOME/.venvs/mlx/bin/python" "$HOME/.mlx/ring_test.py"
"""

import mlx.core as mx

world = mx.distributed.init()
x = mx.distributed.all_sum(mx.ones(4))
mx.eval(x)
print(f"rank {world.rank()}/{world.size()} all_sum -> {x.tolist()}", flush=True)
