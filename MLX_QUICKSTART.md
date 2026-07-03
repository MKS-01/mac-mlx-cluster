# MLX-LM Quick Start (Apple Silicon)

Run local LLMs on your Mac's GPU with Apple's **MLX** framework.

## Setup (already done on this machine)

- **Install location:** virtual environment at `~/.venvs/mlx` (built on Python 3.12)
- **PATH:** configured in `~/.zshenv` (guarded, no duplicates) so `mlx_lm.*` commands
  work in every terminal — interactive, scripts, and login shells.
- **GPU:** Metal backend verified available.

If you ever open a shell and the command isn't found, reload your env once:

```sh
source ~/.zshenv
```

## Run a chat session

```sh
mlx_lm.chat --model mlx-community/Qwen3.5-9B-4bit --max-tokens 2048
```

- You'll get a `>>` prompt — type a message, press Enter, read the reply, repeat.
- Exit with `Ctrl+D` or `Ctrl+C`.
- First run of any *new* model downloads weights (a few GB) to
  `~/.cache/huggingface/hub`; later runs load instantly from cache.

> Note: `Qwen3.5-9B` is a **reasoning model** — it prints its thinking before the
> final answer, so a high `--max-tokens` (e.g. 2048) is recommended.

## Useful flags (`mlx_lm.chat`)

| Flag | Purpose |
|------|---------|
| `--model <repo>` | Hugging Face repo id (e.g. `mlx-community/Qwen3.5-9B-4bit`) |
| `--max-tokens 2048` | Max tokens to generate per reply |
| `--temp 0.7` | Sampling temperature (higher = more random) |
| `--top-p 0.9` | Nucleus sampling cutoff |
| `--seed 0` | Reproducible output |
| `--max-kv-size N` | Cap the KV cache (limits context memory) |

## Other MLX commands

```sh
# One-shot generation (non-interactive, scriptable)
mlx_lm.generate --model mlx-community/Qwen3.5-9B-4bit \
  --prompt "Explain unified memory in one paragraph." --max-tokens 512

# OpenAI-compatible local API server (http://localhost:8080)
mlx_lm.server --model mlx-community/Qwen3.5-9B-4bit

# Convert / quantize a HF model to MLX format
mlx_lm.convert --hf-path <hf-repo> -q

# Benchmark tokens/sec
mlx_lm.benchmark --model mlx-community/Qwen3.5-9B-4bit
```

## Models already downloaded (in `~/.cache/huggingface/hub`)

| Repo | Notes |
|------|-------|
| `mlx-community/Qwen3.5-9B-4bit` | 5.6 GB — main chat model (reasoning) |
| `mlx-community/Qwen2.5-VL-7B-Instruct-4bit` | vision-language model |
| `unsloth/Llama-3.2-1B` | small Llama |
| `senstella/csm-1b-mlx`, `sesame/csm-1b` | CSM speech models |
| `kyutai/moshiko-pytorch-bf16` | Moshi (audio) |

## Managing the model cache

```sh
# See everything cached, with sizes
hf cache scan

# Inspect one repo's disk usage
du -sh ~/.cache/huggingface/hub/models--mlx-community--Qwen3.5-9B-4bit

# Remove a model you no longer want
rm -rf ~/.cache/huggingface/hub/models--mlx-community--<org>--<name>
```

## Troubleshooting

- **`zsh: command not found: mlx_lm.chat`** → run `source ~/.zshenv`, or open a new
  terminal. (PATH is set in `~/.zshenv`.)
- **Download seems to "restart" at 0%** → don't `Ctrl+C` mid-download. The Xet
  transfer backend creates a fresh temp file per attempt instead of resuming, so
  interrupting effectively starts that shard over. Let it run once, uninterrupted.
- **Wrong model name / 404** → browse <https://huggingface.co/mlx-community> for the
  exact repo id. (Names often include `-MLX-`, `-4bit`, `-8bit`, etc.)
- **EOFError traceback when piping a prompt** → harmless; the REPL hit end-of-input
  after one prompt. Only happens with piped input, not normal interactive use.
