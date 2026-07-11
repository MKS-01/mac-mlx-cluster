// The agent's tools: read/list/write files and run bash, all confined to one
// working directory (the root passed to /agent). Everything here is pure
// logic + filesystem/process I/O — no UI. The loop (agentLoop.ts) decides
// when to run a tool and whether to ask the user first (writeFile and bash
// are marked needsConfirm); this module just does the work and returns a
// string result for the model to read.

import { resolve, relative, isAbsolute, join, dirname } from "node:path";
import { existsSync, realpathSync, mkdirSync } from "node:fs";
import type { ToolSpec } from "../chat/chat";

export interface ToolContext {
  root: string; // absolute path the agent is confined to
}

export interface AgentTool {
  spec: ToolSpec;
  // A one-line human summary of a specific call, for the transcript and the
  // confirmation prompt (e.g. `write_file src/index.ts (1.2 KB)`).
  summarize: (args: Record<string, unknown>) => string;
  // Whether this call must be confirmed by the user before it runs.
  needsConfirm: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export class ToolError extends Error {}

// Resolve a model-supplied path against the root and refuse anything that
// escapes it (../, absolute paths outside root, symlink-style tricks). The
// model runs on the same machine as our files, so this boundary is the only
// thing between "edit this project" and "edit anything the user can".
function confine(root: string, p: unknown): string {
  if (typeof p !== "string" || p.trim() === "") {
    throw new ToolError("missing or empty 'path'");
  }
  const abs = isAbsolute(p) ? resolve(p) : resolve(join(root, p));
  const outside = (base: string, target: string) => {
    const rel = relative(base, target);
    return rel !== "" && (rel.startsWith("..") || isAbsolute(rel));
  };
  // Textual check catches plain ../ and absolute-path escapes…
  if (outside(root, abs)) {
    throw new ToolError(`path '${p}' is outside the agent's working directory`);
  }
  // …and the realpath check catches a symlink inside root that points outside
  // it. For not-yet-created paths (write_file), the nearest existing ancestor
  // is what a write would actually traverse, so realpath that.
  let existing = abs;
  while (!existsSync(existing)) existing = dirname(existing); // terminates: "/" exists
  if (outside(realpathSync(root), realpathSync(existing))) {
    throw new ToolError(`path '${p}' resolves outside the agent's working directory (symlink)`);
  }
  return abs;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

const READ_LIMIT = 200_000; // don't feed the model a huge file blind
const BASH_TIMEOUT_MS = 120_000; // builds/tests fit; a hung command doesn't wedge the loop

export const TOOLS: AgentTool[] = [
  {
    spec: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file within the working directory and return its contents.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File path relative to the working directory." } },
          required: ["path"],
        },
      },
    },
    needsConfirm: false,
    summarize: (a) => `read_file ${a.path}`,
    run: async (a, ctx) => {
      const abs = confine(ctx.root, a.path);
      const file = Bun.file(abs);
      if (!(await file.exists())) throw new ToolError(`no such file: ${a.path}`);
      const text = await file.text();
      return text.length > READ_LIMIT
        ? text.slice(0, READ_LIMIT) + `\n… [truncated at ${humanBytes(READ_LIMIT)}; file is ${humanBytes(text.length)}]`
        : text || "(empty file)";
    },
  },
  {
    spec: {
      type: "function",
      function: {
        name: "list_dir",
        description: "List the entries of a directory within the working directory.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory path relative to the working directory (default: the root)." } },
          required: [],
        },
      },
    },
    needsConfirm: false,
    summarize: (a) => `list_dir ${a.path ?? "."}`,
    run: async (a, ctx) => {
      const abs = confine(ctx.root, a.path ?? ".");
      const proc = Bun.spawnSync(["ls", "-laA", abs]);
      if (proc.exitCode !== 0) throw new ToolError(`cannot list ${a.path ?? "."}: ${proc.stderr.toString().trim()}`);
      return proc.stdout.toString().trim() || "(empty directory)";
    },
  },
  {
    spec: {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or overwrite a text file within the working directory. Writes the full contents; there is no append.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to the working directory." },
            content: { type: "string", description: "The complete file contents to write." },
          },
          required: ["path", "content"],
        },
      },
    },
    needsConfirm: true,
    summarize: (a) => `write_file ${a.path} (${humanBytes(typeof a.content === "string" ? a.content.length : 0)})`,
    run: async (a, ctx) => {
      const abs = confine(ctx.root, a.path);
      const content = typeof a.content === "string" ? a.content : "";
      // mkdir -p the parent so the model can create nested files in one call.
      mkdirSync(dirname(abs), { recursive: true });
      await Bun.write(abs, content);
      return `wrote ${humanBytes(content.length)} to ${a.path}`;
    },
  },
  {
    spec: {
      type: "function",
      function: {
        name: "bash",
        description: "Run a bash command in the working directory and return its stdout, stderr, and exit code. Use for builds, tests, git, etc.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "The bash command line to run." } },
          required: ["command"],
        },
      },
    },
    needsConfirm: true,
    summarize: (a) => `bash ${String(a.command ?? "").replace(/\s+/g, " ").slice(0, 60)}`,
    run: async (a, ctx) => {
      const command = a.command;
      if (typeof command !== "string" || !command.trim()) throw new ToolError("missing 'command'");
      // Async spawn (spawnSync would freeze the Ink UI — and Esc with it — for
      // the whole run) with a hard timeout so a hung command can't wedge the
      // agent loop; nothing here is interactive, so stdin is closed.
      const proc = Bun.spawn(["bash", "-lc", command], {
        cwd: ctx.root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, BASH_TIMEOUT_MS);
      let out: string;
      let err: string;
      try {
        [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        await proc.exited;
      } finally {
        clearTimeout(timer);
      }
      const parts = [timedOut ? `killed after ${BASH_TIMEOUT_MS / 1000}s timeout` : `exit code: ${proc.exitCode}`];
      if (out.trim()) parts.push(`stdout:\n${out.trim()}`);
      if (err.trim()) parts.push(`stderr:\n${err.trim()}`);
      const joined = parts.join("\n");
      return joined.length > READ_LIMIT ? joined.slice(0, READ_LIMIT) + "\n… [truncated]" : joined;
    },
  },
];

export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => t.spec);
export const TOOL_BY_NAME: Record<string, AgentTool> = Object.fromEntries(TOOLS.map((t) => [t.spec.function.name, t]));
