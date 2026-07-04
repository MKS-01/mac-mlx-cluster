#!/usr/bin/env python3
"""Debugging/testing utility: a minimal interactive client for poking an
mlx_lm.server (OpenAI-compatible) endpoint — verify streaming and multi-turn
context work end to end without needing mlx-cluster-cli (the real chat
client) built or running. For a single-shot check, `curl` is enough
(see CLUSTER_SETUP.md §8); reach for this when you need more than one turn.

Usage: python3 chat.py [--url http://10.0.0.1:8080] [--system "..."]
Default URL comes from $MLX_SERVER_URL if set.
Stdlib only — no packages needed. Ctrl+C or `q` to quit.
"""

import argparse
import json
import os
import urllib.error
import urllib.request


def stream_chat(url, messages, max_tokens, timeout):
    req = urllib.request.Request(
        f"{url}/v1/chat/completions",
        data=json.dumps(
            {"messages": messages, "max_tokens": max_tokens, "stream": True}
        ).encode(),
        headers={"Content-Type": "application/json"},
    )
    chunks = []
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        for line in resp:
            line = line.decode().strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                continue
            try:
                choices = json.loads(payload)["choices"]
            except (json.JSONDecodeError, KeyError):
                continue  # keep-alive / error / usage events
            if not choices:
                continue
            chunk = choices[0].get("delta", {}).get("content") or ""
            print(chunk, end="", flush=True)
            chunks.append(chunk)
    print()
    return "".join(chunks)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--url", default=os.environ.get("MLX_SERVER_URL", "http://10.0.0.1:8080")
    )
    ap.add_argument("--system", default=None)
    ap.add_argument("--max-tokens", type=int, default=2048)
    ap.add_argument(
        "--timeout", type=int, default=120, help="per-read timeout, seconds"
    )
    args = ap.parse_args()

    messages = []
    if args.system:
        messages.append({"role": "system", "content": args.system})

    print(f"Chatting with {args.url} — 'q' or Ctrl+C to quit.")
    try:
        while True:
            user = input("\n>> ").strip()
            if user in ("q", "quit", "exit"):
                break
            if not user:
                continue
            messages.append({"role": "user", "content": user})
            try:
                reply = stream_chat(args.url, messages, args.max_tokens, args.timeout)
            except (urllib.error.URLError, OSError) as e:
                messages.pop()  # drop the unanswered message, keep the session
                print(f"\n[error] {e} — is the server up? ({args.url})")
                continue
            messages.append({"role": "assistant", "content": reply})
    except (KeyboardInterrupt, EOFError):
        pass
    print("bye")


if __name__ == "__main__":
    main()
