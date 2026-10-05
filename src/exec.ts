import { spawn } from "node:child_process";
import { BuildToolError } from "./errors.ts";

export interface ExecEvent {
  stream: "stdout" | "stderr";
  line: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called once per complete line of output, for progress streaming. */
  onEvent?: (e: ExecEvent) => void;
  /** When true, a non-zero exit resolves normally instead of throwing. */
  allowNonZero?: boolean;
  /**
   * Called with the latest text of a line that is being redrawn in place with
   * carriage returns (download bars, spinners), so long silent steps can show
   * progress. The finished line still arrives through onEvent.
   */
  onProgress?: (text: string) => void;
  /** Kill the process and fail if it runs longer than this. */
  timeoutMs?: number;
}

/**
 * After a process exits, how long to wait for its output pipes to close. A
 * helper it started (an installer, a background server) can inherit the pipes
 * and hold them open long after the process itself is done; the result must
 * not wait for that.
 */
const EXIT_GRACE_MS = 3000;

export interface ExecResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Thin promise wrapper around child_process.spawn with line-buffered streaming.
 * `shell: false` always — arguments are passed as an array so nothing the caller
 * supplies (target name, feature list) is ever interpreted by a shell.
 *
 * The child gets no stdin: a tool that unexpectedly stops to ask a question
 * fails at once instead of waiting forever for an answer nobody can type.
 */
export function exec(
  command: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const start = Date.now();
  const printable = [command, ...args].join(" ");

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(wrapSpawnError(command, err));
      return;
    }

    let stdout = "";
    let stderr = "";
    const partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

    /** A line redrawn with \r keeps only its final state. */
    const lastDraw = (line: string) => {
      const parts = line.replace(/\r$/, "").split("\r").filter((p) => p.trim());
      return parts.at(-1) ?? "";
    };

    const pump = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (!opts.onEvent && !opts.onProgress) return;
      partial[stream] += text;
      let nl: number;
      while ((nl = partial[stream].indexOf("\n")) !== -1) {
        const line = lastDraw(partial[stream].slice(0, nl));
        partial[stream] = partial[stream].slice(nl + 1);
        opts.onEvent?.({ stream, line });
      }
      // A line still being redrawn in place: report its current state.
      if (opts.onProgress && partial[stream].includes("\r")) {
        const now = lastDraw(partial[stream]).trim();
        if (now) opts.onProgress(now);
      }
    };

    child.stdout.on("data", (c: Buffer) => pump("stdout", c));
    child.stderr.on("data", (c: Buffer) => pump("stderr", c));

    let settled = false;
    let timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      for (const s of ["stdout", "stderr"] as const) {
        const line = lastDraw(partial[s]);
        if (line && opts.onEvent) opts.onEvent({ stream: s, line });
      }
      const result: ExecResult = { command: printable, code, stdout, stderr, durationMs: Date.now() - start };
      if (timedOut) {
        reject(new BuildToolError("BUILD_FAILED", `\`${printable}\` did not finish within ${Math.round(opts.timeoutMs! / 60000)} min and was stopped`,
          stderr.trim() || stdout.trim()));
      } else if (code === 0 || opts.allowNonZero) {
        resolve(result);
      } else {
        reject(new BuildToolError("BUILD_FAILED", `\`${printable}\` exited with code ${code}`, stderr.trim() || stdout.trim()));
      }
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      reject(wrapSpawnError(command, err));
    });
    // Normally the pipes close right after the exit; if something else holds
    // them open, finish anyway after a short grace period.
    child.on("exit", (code) => {
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code ?? -1);
      }, EXIT_GRACE_MS);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

function wrapSpawnError(command: string, err: unknown): BuildToolError {
  const isEnoent =
    typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
  if (isEnoent && command === "git")
    return new BuildToolError("GIT_NOT_FOUND", "`git` was not found on PATH.");
  if (isEnoent && command === "make")
    return new BuildToolError(
      "MAKE_NOT_FOUND",
      "`make` was not found on PATH. On Windows install GNU make (`winget install ezwinports.make`) and Git for Windows; the app offers to do this (Load build environment).",
    );
  return new BuildToolError(
    "BUILD_FAILED",
    `Failed to start \`${command}\`: ${(err as Error).message}`,
  );
}

/** Convenience: run a command purely for its stdout, trimmed. */
export async function execCapture(
  command: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<string> {
  const r = await exec(command, args, opts);
  return r.stdout.trim();
}
