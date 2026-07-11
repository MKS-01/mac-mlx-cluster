#!/usr/bin/env bash
# mlx-cluster — build a standalone binary and install it on PATH.
#
#   ./install.sh                  # → ~/.local/bin/mlx-cluster
#   MLX_CLI_BIN_DIR=/usr/local/bin ./install.sh
#
# Re-run after pulling new changes; the binary is self-contained (Bun runtime
# included).
set -euo pipefail

cd "$(dirname "$0")"
BIN_DIR="${MLX_CLI_BIN_DIR:-$HOME/.local/bin}"
BIN_NAME="mlx-cluster"

command -v bun >/dev/null 2>&1 || {
  echo "error: bun is required — install it from https://bun.sh" >&2
  exit 1
}

echo "▸ installing dependencies…"
bun install

echo "▸ compiling ${BIN_NAME}…"
bun build ./src/index.tsx --compile --outfile "dist/${BIN_NAME}"

mkdir -p "$BIN_DIR"
install -m 755 "dist/${BIN_NAME}" "${BIN_DIR}/${BIN_NAME}"
echo "✓ installed ${BIN_DIR}/${BIN_NAME}"

case ":$PATH:" in
  *":${BIN_DIR}:"*) echo "✓ ${BIN_DIR} is on your PATH — run: ${BIN_NAME}" ;;
  *)
    echo "⚠ ${BIN_DIR} is not on your PATH — add this to ~/.zshrc:"
    echo "    export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

if [ ! -f "$HOME/.mlx/cluster-cli.json" ]; then
  echo "⚠ no ~/.mlx/cluster-cli.json found — copy config.example.json there and fill in your usernames/IPs"
fi
