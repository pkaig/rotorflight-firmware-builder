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
}

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
      });
    } catch (err) {
      reject(wrapSpawnError(command, err));
      return;
    }

    let stdout = "";
    let stderr = "";
    const partial: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

    const pump = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stream === "stdout") stdout += text;
      else stderr += text;
      if (!opts.onEvent) return;
      partial[stream] += text;
      let nl: number;
      while ((nl = partial[stream].indexOf("\n")) !== -1) {
        const line = partial[stream].slice(0, nl).replace(/\r$/, "");
        partial[stream] = partial[stream].slice(nl + 1);
        opts.onEvent({ stream, line });
      }
    };

    child.stdout.on("data", (c: Buffer) => pump("stdout", c));
    child.stderr.on("data", (c: Buffer) => pump("stderr", c));

    child.on("error", (err) => reject(wrapSpawnError(command, err)));

    child.on("close", (code) => {
      for (const s of ["stdout", "stderr"] as const) {
        if (partial[s] && opts.onEvent) opts.onEvent({ stream: s, line: partial[s] });
      }
      const result: ExecResult = {
        command: printable,
        code: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      };
      if (code === 0 || opts.allowNonZero) resolve(result);
      else
        reject(
          new BuildToolError(
            "BUILD_FAILED",
            `\`${printable}\` exited with code ${code}`,
            stderr.trim() || stdout.trim(),
          ),
        );
    });
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
