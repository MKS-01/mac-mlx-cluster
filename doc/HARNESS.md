# HARNESS.md — local coding agent on the cluster

An agent harness for working **on this repo** with locally served Qwen, inspired by
[Anthropic's harness-design article](https://www.anthropic.com/engineering/harness-design-long-running-apps):
a worker agent does the coding, and a separate **evaluator** with fresh context judges
the result before the task is declared done. The worker is [OpenCode](https://opencode.ai)
pointed at `mlx_lm.server`'s OpenAI-compatible API; the evaluator is an OpenCode subagent
defined in this repo's `opencode.json`.

Why this shape (short version of the article): models grade their own work too generously,
so generation and evaluation are split; the evaluator runs in a fresh context (a subagent)
so it judges the diff on evidence, not on the worker's narrative; explicit grading criteria
(contract → correctness → checks → UI → CLI invariants → repo rules) steer both agents.
UI is graded in the same pass as functionality: any `src/cli` change that touches terminal
output is checked against the design system (colors only from `src/ui/theme.ts` /
`colorScale.ts`, named-export Ink components in `src/ui/components/`, and per-frame line
counts kept in sync with `src/ui/app.tsx`'s line-budget constants — the full rule set lives
in `.claude/skills/design-system/SKILL.md`). The
same pass also enforces the CLI's structural invariants: config fields regex-validated (they
reach SSH/shell argv) and mirrored in `config.example.json`, bridge-IP/`127.0.0.1` binding
only, servers stopped on every exit path, prefs written only through `src/config/prefs.ts`.

## Requirements

- `mlx-lm` ≥ 0.31 in `~/.venvs/mlx` — its server has native tool calling (detects support
  from the model's tokenizer, parses Qwen `<tool_call>` blocks, returns OpenAI `tool_calls`
  in both streaming and non-streaming responses). No flags needed.
- A tool-calling model. Verified: `mlx-community/Qwen3.6-35B-A3B-4bit-DWQ`.
- [OpenCode](https://opencode.ai): `brew install opencode`.

## Run it

1. **Serve.** Either the normal Pattern A server (`mlxctl server status` to check — see
   `CLUSTER_SETUP.md`), or a local server on the dev Mac:

   ```sh
   HF_HUB_OFFLINE=1 mlx_lm.server --model mlx-community/Qwen3.6-35B-A3B-4bit-DWQ \
     --host 127.0.0.1 --port 8080
   ```

2. **Start the agent** at the repo root (that's where `opencode.json` and `AGENTS.md` live):

   ```sh
   opencode            # interactive TUI
   opencode run "..."  # one-shot
   ```

3. **Pick the provider/model** with `/models`: `mlx-cluster/…` targets the Pattern A server
   on `10.0.0.1:8080`; `mlx-local/…` targets `127.0.0.1:8080`. Both list the same three
   Qwen models; the server loads whichever is requested from the shared HF cache.

4. **Give it a task.** `AGENTS.md` instructs the worker to invoke the `@evaluator` subagent
   when it thinks it's done, fix reported defects, and re-evaluate (max 3 rounds). You can
   also invoke it manually: `@evaluator check the last change against <task>`.

One server, all clients: the harness deliberately shares whatever `mlx_lm.server` is
already running — the LaunchAgent on the M1, or the one `mlx-cluster-cli`'s local
fallback started. Never start a second server on the same Mac for the harness (it
would double model RAM); conversely, if the harness's own local server is running on
port 8080, `mlx-cluster-cli`'s local fallback will refuse to start its own there —
one of them owns the port, both can talk to it.

## Recommended models

Grounded in what `mlxctl search` shows on mlx-community as of Jul 2026. Sizing rules of
thumb from the repo: 35B-A3B is 19.3 GB at 4bit-DWQ, so ≈24 GB at 5bit / ≈29 GB at 6bit;
the M1 (32 GB) can serve up to roughly the 20 GB class, the M5 (48 GB) up to roughly 29 GB.

Already cached:

- `mlx-community/Qwen3.6-35B-A3B-4bit-DWQ` — the default worker. MoE (fast), DWQ
  (better than plain 4bit at the same size), fits either Mac.
- `mlx-community/Qwen3.6-27B-4bit` — dense fallback if MoE tool-call JSON flakes.
- `mlx-community/Qwen3.5-9B-4bit` — quick smoke tests only; too weak as a worker.

Worth downloading later (in this order):

1. `mlx-community/Qwen3.6-35B-A3B-5bit` (~24 GB) — same model, one quant up; the
   cheapest way to buy tool-call reliability. M5-only.
2. `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ` (~17 GB) — previous
   generation but coder-tuned and non-thinking: no reasoning tax on the output
   budget, faster agent turns, strong agentic tool calling. Fits the M1, so it can
   serve as the always-on Pattern A harness model.
3. `mlx-community/Qwen3.6-35B-A3B-6bit` (~29 GB) — quality ceiling for a single
   Mac here; M5-only, leaves little headroom next to OpenCode's context.

Add new models to both provider blocks in `opencode.json` when downloaded.

## Configuration map

| File | Role |
|---|---|
| `opencode.json` (repo root) | Providers (`mlx-cluster`, `mlx-local`), model limits, the `evaluator` subagent + its grading prompt |
| `AGENTS.md` (repo root) | Worker's project instructions: layout, repo rules, the evaluate-fix loop |
| `~/.mlx/cluster-cli.json` | Not read by OpenCode — but it's where the serving side (CLI/LaunchAgent) is configured; keep IPs consistent |

## Using the harness in other projects

Only OpenCode is directory-bound: the directory you launch `opencode` in is its
workspace — it loads `opencode.json` and `AGENTS.md` from there, and its tools operate
on that tree. The serving side (`mlx_lm.server`, the models, `mlx-cluster-cli`) is
completely project-independent; a new project needs zero new server setup.

To use the same local models in another project, get the provider config there one of
two ways:

1. **Global providers (recommended once you use more than one project).** Move the
   `provider` block — plus `model`/`small_model` — from this repo's `opencode.json`
   into `~/.config/opencode/opencode.json`. Every project then sees the
   `mlx-cluster`/`mlx-local` models with no per-project setup; project files can stay
   minimal or omit `opencode.json` entirely. (Config merges: a project file still
   overrides globals where both define the same key.)
2. **Copy per project.** Copy `opencode.json` into the new project's root and prune.
   Fine for one or two projects.

Per project, then optionally add:

- **`AGENTS.md`** at its root — that project's rules for the worker (layout,
  build/test commands, what not to touch). The harness works without it, but a local
  model benefits a lot from explicit rules; keep it short (its context is precious).
- **An evaluator agent** — the pattern (read-only subagent, graded criteria, PASS/FAIL
  verdict) transfers to any project; the criteria do not. Rewrite criterion 3+ around
  that project's real checks (its test runner, its linter, its conventions) — this
  repo's version grades `ruff`, `bun run build`, and the Ink design system, which
  mean nothing elsewhere.

Commands, end to end:

```sh
# --- option 1, one-time: make the providers global (run from this repo's root) ---
mkdir -p ~/.config/opencode
cp opencode.json ~/.config/opencode/opencode.json
# then edit ~/.config/opencode/opencode.json and delete the "agent" block —
# the evaluator's criteria are specific to this repo and don't belong globally

# --- option 2, per project: copy instead (run from this repo's root) ---
cp opencode.json /path/to/new-project/opencode.json
# same pruning applies; rewrite the evaluator prompt for that project's checks

# --- daily use, any project ---
# 1. a server must be up — the M1 LaunchAgent (mlxctl server status), or local:
HF_HUB_OFFLINE=1 mlx_lm.server --model mlx-community/Qwen3.6-35B-A3B-4bit-DWQ \
  --host 127.0.0.1 --port 8080
# 2. run the agent AT the project root (its cwd = its workspace):
cd /path/to/new-project
opencode                      # interactive TUI: /models to pick, Tab for agents,
                              # /new per task, /undo to revert, Esc to interrupt
opencode run "short question" # one-shots: keep them SHORT (see known issue below)
```

## Verification status

Verified on 2026-07-07 (mlx-lm 0.31.3, OpenCode 1.17.10, Qwen3.6-35B-A3B-4bit-DWQ,
local server on the M5):

- ✅ Server tool calling — structured `tool_calls` with valid JSON, streaming and
  non-streaming, `finish_reason: "tool_calls"`, reasoning kept separate.
- ✅ OpenCode → server wiring — real glob/read tool calls executed end-to-end.
- ⚠️ The full worker → evaluator loop has **not** been verified end-to-end yet —
  blocked by the `opencode run` hang below. Verify it interactively (TUI) when
  first using the harness in anger.

## Known issue: long `opencode run` one-shot prompts hang

With OpenCode 1.17.10, `opencode run "<long multi-sentence task>"` reproducibly
hangs after instance init — before a session is created or any request reaches the
server (so it's an OpenCode issue, not the model/server). Short one-shot prompts and
the interactive TUI work fine.

Workarounds: use the interactive TUI for real tasks (the intended mode anyway); for
scripted runs keep the message short and put the details in a file the prompt points
at (e.g. "do the task described in TASK.md").

## Troubleshooting

- **"model does not support tool calling"** (HTTP 400) — the selected model's tokenizer has
  no tool-call template. Switch to a Qwen 3.5/3.6 instruct model.
- **Empty replies / cut off mid-thought** — Qwen3.6's thinking tokens count against the
  output budget. `opencode.json` sets `limit.output` to 32768; don't lower it much.
- **Malformed tool-call JSON** — happens occasionally with 4-bit quants; the server reports
  a parse failure and OpenCode retries. If it's frequent, try the 27B dense model or a
  higher-quant variant.
- **Slow first response per model** — the server loads the model lazily on first request
  (~20 GB from disk). Keep `small_model` pointed at the same model as `model` (as committed)
  or every summarization request thrashes a model reload.
- **One request at a time** — worker and evaluator share one server; evaluation blocks
  generation. Expected, just slower than cloud agents.
- **Connection refused on `10.0.0.1`** — Thunderbolt bridge or the M1's server is down;
  run the `/debug` diagnostic (or use `mlx-local` with a locally started server meanwhile).
