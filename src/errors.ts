/**
 * Typed error hierarchy for the build pipeline.
 *
 * Every failure mode the scope doc calls out in §6.1 ("clean failure on missing
 * toolchain, checksum mismatch, failed clone, disk space") maps to one of these,
 * so the CLI — and later the Configurator tab — can react to `err.code` rather
 * than parsing message strings.
 */

export type BuildToolErrorCode =
  | "INVALID_ARGS"
  | "UNKNOWN_TARGET"
  | "UNKNOWN_FEATURE"
  | "GIT_NOT_FOUND"
  | "MAKE_NOT_FOUND"
  | "CLONE_FAILED"
  | "CHECKOUT_FAILED"
  | "TOOLCHAIN_INSTALL_FAILED"
  | "TOOLCHAIN_VERSION_MISMATCH"
  | "CHECKSUM_MISMATCH"
  | "DISK_SPACE"
  | "BUILD_FAILED"
  | "ARTIFACT_NOT_FOUND";

export class BuildToolError extends Error {
  readonly code: BuildToolErrorCode;
  /** Optional captured process output, for surfacing to the user. */
  readonly detail?: string;

  constructor(code: BuildToolErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "BuildToolError";
    this.code = code;
    this.detail = detail;
  }
}

export function isBuildToolError(e: unknown): e is BuildToolError {
  return e instanceof BuildToolError;
}
