import type { Finding } from "./types";

/** Machine-readable events emitted by `cyclon scan --events`. */
export type CyclonEvent =
  | { type: "start"; root: string; files: number; agents: string[]; models?: string[] }
  | { type: "file_start"; file: string; agent: string }
  | { type: "finding"; file: string; agent: string; finding: Finding }
  | { type: "file_done"; file: string; agent: string; count: number; cached?: boolean }
  | { type: "error"; file: string; agent: string; message: string }
  | { type: "done"; files_scanned: number; findings: number; errors: number };

export const EVENT_PREFIX = "@@cyclon@@ ";

export function parseCyclonEvent(line: string): CyclonEvent | undefined {
  if (!line.startsWith(EVENT_PREFIX)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line.slice(EVENT_PREFIX.length)) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as CyclonEvent;
    }
  } catch {
    // Not a valid event line; treat it as ordinary log output.
  }
  return undefined;
}
