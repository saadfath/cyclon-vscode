import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import * as vscode from "vscode";

import type { ScanPayload, ScanRecord } from "./types";

export class CyclonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclonError";
  }
}

export class ScanCancelledError extends Error {
  constructor() {
    super("Scan cancelled");
    this.name = "ScanCancelledError";
  }
}

export interface RunOptions {
  /** Absolute path to the file or directory to scan. */
  target: string;
  /** Absolute path where the CLI should write its HTML report. */
  htmlPath: string;
  /** Extra environment variables (API keys, base URL). */
  env: NodeJS.ProcessEnv;
  /** Per-run prompt override. Falls back to the `cyclon.extraPrompt` setting. */
  extraPrompt?: string;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class CyclonRunner {
  private child: ChildProcess | undefined;
  private cancelled = false;
  private timedOut = false;

  get running(): boolean {
    return this.child !== undefined;
  }

  cancel(): void {
    this.cancelled = true;
    this.killChild();
  }

  private killChild(): void {
    const child = this.child;
    if (!child) {
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    const pid = child.pid;
    if (pid) {
      setTimeout(() => {
        if (this.child !== child) {
          return;
        }
        try {
          // On POSIX, kill the whole process group if the child spawned helpers.
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            // Ignore.
          }
        }
      }, 3000).unref();
    }
  }

  async run(
    options: RunOptions,
    token: vscode.CancellationToken,
    onLog: (line: string) => void,
  ): Promise<ScanRecord> {
    this.cancelled = false;
    this.timedOut = false;

    const cfg = vscode.workspace.getConfiguration("cyclon");
    const args = buildArgs(options, cfg);
    const cwd = workspaceCwd(options.target);
    const command = (cfg.get<string>("command", "cyclon") || "cyclon").trim();

    let result: ExecResult;
    try {
      result = await this.exec(command, args, cwd, options.env, token, onLog);
    } catch (error) {
      if (isEnoent(error)) {
        const python = (cfg.get<string>("pythonPath", "python3") || "python3").trim();
        onLog(`'${command}' not found on PATH — falling back to ${python} -m cyclon`);
        try {
          result = await this.exec(python, ["-m", "cyclon", ...args], cwd, options.env, token, onLog);
        } catch (fallbackError) {
          if (isEnoent(fallbackError)) {
            throw new CyclonError(
              `Could not find the cyclon CLI. Install it with "pip install -e cli-cyclon" or set "cyclon.command" / "cyclon.pythonPath".`,
            );
          }
          throw fallbackError;
        }
      } else {
        throw error;
      }
    }

    if (this.timedOut) {
      const minutes = cfg.get<number>("timeoutMinutes", 20);
      throw new CyclonError(`Scan timed out after ${minutes} minute(s).`);
    }
    if (this.cancelled) {
      throw new ScanCancelledError();
    }

    if (result.code !== 0) {
      const text = (result.stderr || result.stdout).trim();
      const tail = text.split(/\r?\n/).slice(-12).join("\n");
      if (/no api key/i.test(text)) {
        throw new CyclonError('No xAI API key configured. Run "Cyclon: Set API Keys" first.');
      }
      throw new CyclonError(tail || `cyclon exited with code ${result.code ?? "unknown"}.`);
    }

    const payload = parsePayload(result.stdout);
    return {
      ...payload,
      target: options.target,
      scannedAt: Date.now(),
      reportPath: options.htmlPath,
    };
  }

  private exec(
    command: string,
    args: string[],
    cwd: string | undefined,
    env: NodeJS.ProcessEnv,
    token: vscode.CancellationToken,
    onLog: (line: string) => void,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        // Detach on POSIX so we can terminate the whole tree on cancel.
        detached: process.platform !== "win32",
      });
      this.child = child;

      const cfg = vscode.workspace.getConfiguration("cyclon");
      const minutes = cfg.get<number>("timeoutMinutes", 20);
      const timeoutMs = minutes > 0 ? minutes * 60_000 : 0;

      let stdout = "";
      let stderr = "";
      let stderrBuffer = "";
      let settled = false;

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.timedOut = true;
              this.killChild();
            }, timeoutMs)
          : undefined;

      const cancelSub = token.onCancellationRequested(() => this.cancel());

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        cancelSub.dispose();
        if (this.child === child) {
          this.child = undefined;
        }
      };

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            onLog(line);
          }
        }
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (stderrBuffer.trim()) {
          onLog(stderrBuffer);
        }
        resolve({ code, stdout, stderr });
      });
    });
  }
}

function buildArgs(options: RunOptions, cfg: vscode.WorkspaceConfiguration): string[] {
  const args = ["scan", options.target, "--json", "--no-open", "--html", options.htmlPath];

  if (!cfg.get<boolean>("useCache", true)) {
    args.push("--no-cache");
  }

  const model = (cfg.get<string>("model", "") || "").trim();
  if (model) {
    args.push("--model", model);
  }

  const concurrency = cfg.get<number>("concurrency", 4);
  if (Number.isFinite(concurrency) && concurrency > 0) {
    args.push("--concurrency", String(Math.round(concurrency)));
  }

  const maxSize = cfg.get<number>("maxFileSize", 200_000);
  if (Number.isFinite(maxSize) && maxSize > 0) {
    args.push("--max-size", String(Math.round(maxSize)));
  }

  const extensions = cfg.get<string[]>("extensions", []);
  if (Array.isArray(extensions) && extensions.length > 0) {
    args.push("--extensions", extensions.join(","));
  }

  const extraPrompt = (options.extraPrompt ?? cfg.get<string>("extraPrompt", "") ?? "").trim();
  if (extraPrompt) {
    args.push("--extra-prompt", extraPrompt);
  }

  return args;
}

function parsePayload(stdout: string): ScanPayload {
  const text = stdout.trim();
  if (!text) {
    throw new CyclonError("cyclon produced no output.");
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    if (/no files to scan/i.test(text)) {
      throw new CyclonError("No matching files to scan.");
    }
    throw new CyclonError(`Unexpected cyclon output:\n${text.slice(0, 500)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new CyclonError(`Could not parse cyclon JSON output: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CyclonError("cyclon returned an unexpected payload.");
  }

  const payload = parsed as Partial<ScanPayload>;
  if (!Array.isArray(payload.findings)) {
    throw new CyclonError("cyclon output is missing the findings array.");
  }

  return {
    root: typeof payload.root === "string" ? payload.root : "",
    files_scanned: typeof payload.files_scanned === "number" ? payload.files_scanned : 0,
    findings: payload.findings,
    errors: Array.isArray(payload.errors) ? payload.errors.map(String) : [],
  };
}

function workspaceCwd(target: string): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return path.dirname(target);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

/** Create the directory that will hold HTML reports and return a fresh file path. */
export function prepareReportPath(storageDir: string): string {
  const dir = path.join(storageDir, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `report-${stamp}.html`);
}
