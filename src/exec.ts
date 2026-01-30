/**
 * Thin wrapper over node:child_process for ccbox.
 *
 * Replaces execa with minimal child_process utilities.
 */

import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  all?: string;
  timedOut?: boolean;
}

export interface ExecOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  /** Combine stdout+stderr into `all` field */
  all?: boolean;
}

/**
 * Execute a command and capture output. Never rejects (reject:false semantics).
 */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      timeout: opts.timeout ?? 0,
      env: opts.env,
      encoding: opts.encoding ?? "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const stdoutStr = String(stdout ?? "");
      const stderrStr = String(stderr ?? "");
      const timedOut = error?.killed && (error as NodeJS.ErrnoException).code === undefined;
      const exitCode = (error as NodeJS.ErrnoException & { code?: string })?.code === "ENOENT"
        ? -1
        : child.exitCode ?? (error ? 1 : 0);

      // Re-throw ENOENT as a proper error with code
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        const result: ExecResult = { exitCode: 1, stdout: stdoutStr, stderr: stderrStr, timedOut: false };
        // Attach code for callers that check it
        (result as ExecResult & { code?: string }).code = "ENOENT";
        resolve(result);
        return;
      }

      resolve({
        exitCode,
        stdout: stdoutStr,
        stderr: stderrStr,
        ...(opts.all ? { all: stdoutStr + stderrStr } : {}),
        timedOut: timedOut ?? false,
      });
    });
  });
}

export interface ExecInheritOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  /** stdin mode: "inherit" (default) or "ignore" */
  stdin?: "inherit" | "ignore";
  /** If true, throw on non-zero exit code */
  reject?: boolean;
  /** Combine stdout+stderr into `all` */
  all?: boolean;
}

/**
 * Execute with stdio:inherit. Returns exit code.
 * Supports stderr piping when stdio is customized.
 */
export function execInherit(
  cmd: string,
  args: string[],
  opts: ExecInheritOptions & { stdio?: SpawnOptions["stdio"] } = {}
): Promise<ExecResult> & { child: ChildProcess } {
  const stdio = opts.stdio ?? [opts.stdin ?? "inherit", "inherit", "inherit"];
  const child = spawn(cmd, args, {
    stdio,
    env: opts.env,
    timeout: opts.timeout ?? 0,
  });

  const promise = new Promise<ExecResult>((resolve, reject) => {
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      const result: ExecResult = { exitCode, stdout: "", stderr: "" };
      if (opts.reject && exitCode !== 0) {
        const err = new Error(`Command failed: ${cmd} ${args.slice(0, 3).join(" ")}`) as Error & {
          exitCode: number;
          stderr?: string;
          shortMessage?: string;
          timedOut?: boolean;
        };
        err.exitCode = exitCode;
        err.timedOut = false;
        reject(err);
        return;
      }
      resolve(result);
    });
    child.on("error", (error) => {
      if (opts.reject) {
        reject(error);
        return;
      }
      resolve({ exitCode: 1, stdout: "", stderr: String(error) });
    });
  }) as Promise<ExecResult> & { child: ChildProcess };

  (promise as { child: ChildProcess }).child = child;
  return promise;
}

/**
 * Spawn a detached process (fire and forget).
 */
export function execDetached(cmd: string, args: string[]): ChildProcess {
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}
