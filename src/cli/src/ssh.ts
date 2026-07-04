// Thin SSH wrapper. Every call is short-timeout + non-interactive so a dead
// or unauthorized node fails fast with a clear message instead of hanging the
// UI (the classic "ssh sat there for 2 minutes" trap).

export interface RemoteResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

const SSH_OPTS = [
  "-o", "BatchMode=yes", // never prompt for a password/passphrase
  "-o", "ConnectTimeout=5",
  "-o", "StrictHostKeyChecking=accept-new",
];

/**
 * Runs `command` on user@ip over SSH with an overall timeout. Never throws —
 * failures (unreachable host, auth failure, timeout, non-zero exit) are all
 * reported via the returned RemoteResult so callers can show a specific
 * message instead of an unhandled rejection.
 */
export async function runRemote(
  user: string,
  ip: string,
  command: string,
  timeoutMs = 8000,
): Promise<RemoteResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["ssh", ...SSH_OPTS, `${user}@${ip}`, command], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err), code: null, timedOut: false };
  }

  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );
  const exited = proc.exited.then(() => "exited" as const);

  const race = await Promise.race([exited, timeout]);
  if (race === "timeout") {
    proc.kill("SIGKILL");
    return { ok: false, stdout: "", stderr: `ssh to ${user}@${ip} timed out after ${timeoutMs}ms`, code: null, timedOut: true };
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  const code = proc.exitCode;
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code, timedOut: false };
}

/** Quick reachability probe — used to decide cluster vs local mode. */
export async function sshReachable(user: string, ip: string, timeoutMs = 3000): Promise<boolean> {
  const r = await runRemote(user, ip, "true", timeoutMs);
  return r.ok;
}

function describeSshFailure(r: RemoteResult, user: string, ip: string): string {
  if (r.timedOut) return `ssh to ${user}@${ip} timed out — is the Thunderbolt bridge up?`;
  if (r.stderr.includes("Permission denied")) {
    return `ssh auth failed for ${user}@${ip} — check the key is authorized (see CLUSTER_SETUP.md §3)`;
  }
  if (r.stderr.includes("Could not resolve hostname") || r.stderr.includes("No route to host")) {
    return `cannot reach ${ip} — check the bridge is connected and IP is correct`;
  }
  return r.stderr || `ssh to ${user}@${ip} failed (exit ${r.code})`;
}

/**
 * Rewrites the --model argument inside a LaunchAgent plist's
 * ProgramArguments on the remote node, using plistlib so we never hand-edit
 * XML with sed (which breaks on repo names containing slashes/special
 * chars). Encodes the model name as base64 to sidestep all shell-quoting
 * hazards (spaces, quotes, etc. in the argument).
 */
export async function setRemoteModel(
  user: string,
  ip: string,
  plistPath: string,
  model: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const modelB64 = Buffer.from(model, "utf8").toString("base64");
  const py = `
import base64, plistlib, sys
path = "${plistPath}".replace("~", "/Users/${user}", 1) if "${plistPath}".startswith("~") else "${plistPath}"
model = base64.b64decode("${modelB64}").decode()
with open(path, "rb") as f:
    d = plistlib.load(f)
args = d.get("ProgramArguments", [])
if "--model" not in args:
    print("no --model arg found in ProgramArguments", file=sys.stderr)
    sys.exit(1)
i = args.index("--model")
if i + 1 >= len(args):
    print("--model has no value following it", file=sys.stderr)
    sys.exit(1)
args[i + 1] = model
d["ProgramArguments"] = args
with open(path, "wb") as f:
    plistlib.dump(d, f)
print("ok")
`.trim();
  const pyB64 = Buffer.from(py, "utf8").toString("base64");
  const remoteCmd = `echo ${pyB64} | base64 -d | /usr/bin/python3 -`;
  const r = await runRemote(user, ip, remoteCmd, 10_000);
  if (!r.ok) {
    return { ok: false, message: `failed to update remote plist: ${describeSshFailure(r, user, ip)}` };
  }
  return { ok: true };
}

export async function kickstartRemote(
  user: string,
  ip: string,
  serviceLabel: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const cmd = `launchctl kickstart -k gui/$(id -u)/${serviceLabel}`;
  const r = await runRemote(user, ip, cmd, 10_000);
  if (!r.ok) {
    return { ok: false, message: `failed to restart ${serviceLabel}: ${describeSshFailure(r, user, ip)}` };
  }
  return { ok: true };
}

/**
 * Loads the LaunchAgent if it isn't already, so the CLI can bring the M1's
 * server up on demand instead of requiring it to be always-on. If it's
 * already bootstrapped (loaded but crashed/stopped), `bootstrap` fails with
 * "service already bootstrapped" — fall back to `kickstart -k` to restart it.
 */
export async function bootstrapRemote(
  user: string,
  ip: string,
  plistPath: string,
  serviceLabel: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const cmd = `launchctl bootstrap gui/$(id -u) ${plistPath}`;
  const r = await runRemote(user, ip, cmd, 10_000);
  if (r.ok) return { ok: true };
  if (r.stderr.includes("already bootstrapped") || r.stderr.includes("already loaded")) {
    return kickstartRemote(user, ip, serviceLabel);
  }
  return { ok: false, message: `failed to start ${serviceLabel}: ${describeSshFailure(r, user, ip)}` };
}

/** Unloads the LaunchAgent. "Not found" counts as success — already stopped. */
export async function bootoutRemote(
  user: string,
  ip: string,
  serviceLabel: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const cmd = `launchctl bootout gui/$(id -u)/${serviceLabel}`;
  const r = await runRemote(user, ip, cmd, 10_000);
  if (r.ok || r.stderr.includes("Could not find service") || r.stderr.includes("No such process")) {
    return { ok: true };
  }
  return { ok: false, message: `failed to stop ${serviceLabel}: ${describeSshFailure(r, user, ip)}` };
}

/**
 * Synchronous, best-effort bootout for use from process exit / uncaught-
 * exception handlers, where Node won't run async work — we'd rather block
 * briefly on the way out than orphan a model loaded on the M1's RAM.
 */
export function bootoutRemoteSync(user: string, ip: string, serviceLabel: string): void {
  try {
    Bun.spawnSync(
      ["ssh", ...SSH_OPTS, `${user}@${ip}`, `launchctl bootout gui/$(id -u)/${serviceLabel}`],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch {
    // best-effort only — never let cleanup crash the exit path
  }
}
