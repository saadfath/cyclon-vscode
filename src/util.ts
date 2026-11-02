import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import type { Finding, Severity } from "./types";

const RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function severityRank(severity: string | undefined): number {
  return RANK[(severity ?? "").toLowerCase()] ?? 5;
}

export function normalizeSeverity(severity: string | undefined): Severity {
  const s = (severity ?? "").toLowerCase();
  return (SEVERITY_SET.has(s) ? s : "info") as Severity;
}

const SEVERITY_SET = new Set(["critical", "high", "medium", "low", "info"]);

export function toDiagnosticSeverity(severity: string): vscode.DiagnosticSeverity {
  switch (normalizeSeverity(severity)) {
    case "critical":
    case "high":
      return vscode.DiagnosticSeverity.Error;
    case "medium":
      return vscode.DiagnosticSeverity.Warning;
    case "low":
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Hint;
  }
}

export function severityIcon(severity: string): vscode.ThemeIcon {
  switch (normalizeSeverity(severity)) {
    case "critical":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground"));
    case "high":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground"));
    case "medium":
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
    case "low":
      return new vscode.ThemeIcon("info", new vscode.ThemeColor("problemsInfoIcon.foreground"));
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

/**
 * The CLI reports paths relative to the scan root for directory scans, and
 * absolute paths for single-file scans. Resolve both against the record root.
 */
export function resolveFindingUri(root: string, file: string): vscode.Uri {
  if (path.isAbsolute(file)) {
    return vscode.Uri.file(file);
  }
  let base = root;
  try {
    if (fs.statSync(root).isFile()) {
      base = path.dirname(root);
    }
  } catch {
    // Root may no longer exist; fall back to using it as a directory.
  }
  return vscode.Uri.file(path.resolve(base, file));
}

export function findingLocation(finding: Finding, root: string): string {
  const uri = resolveFindingUri(root, finding.file);
  const rel = vscode.workspace.asRelativePath(uri, false);
  return finding.line ? `${rel}:${finding.line}` : rel;
}

export function buildDiagnosticMessage(finding: Finding): string {
  const parts: string[] = [finding.title || "Issue"];
  if (finding.description) {
    parts.push("", finding.description);
  }
  if (finding.suggestion) {
    parts.push("", "Suggested fix:", finding.suggestion);
  }
  return parts.join("\n");
}

export function escapeHtml(value: string | undefined | null): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (!Number.isFinite(delta) || delta < 0) {
    return "just now";
  }
  const seconds = Math.round(delta / 1000);
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
