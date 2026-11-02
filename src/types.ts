/** Shared types mirroring the JSON emitted by `cyclon scan --json`. */

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type SeverityFilter = "all" | Severity;

export interface Finding {
  file: string;
  line?: number | null;
  severity: string;
  category?: string;
  title: string;
  description?: string;
  suggestion?: string;
  agent?: string;
}

export interface ScanPayload {
  root: string;
  files_scanned: number;
  findings: Finding[];
  errors: string[];
}

export interface ScanRecord extends ScanPayload {
  /** Absolute path of the scanned file or directory. */
  target: string;
  /** Epoch ms when the scan finished. */
  scannedAt: number;
  /** Absolute path of the generated HTML report. */
  reportPath: string;
  /** Agent names used for the scan, when known. */
  agents?: string[];
  /** Wall-clock duration of the scan in milliseconds. */
  durationMs?: number;
}

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
