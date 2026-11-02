import * as path from "node:path";

import * as vscode from "vscode";

import type { Finding, ScanRecord, SeverityFilter } from "./types";
import {
  buildDiagnosticMessage,
  resolveFindingUri,
  severityRank,
  toDiagnosticSeverity,
} from "./util";

export interface FindingRef {
  finding: Finding;
  uri: vscode.Uri;
}

const STORAGE_KEY = "cyclon.lastScan";

export class ScanStore {
  private _record: ScanRecord | undefined;
  private _filter: SeverityFilter = "all";
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  private readonly index = new Map<string, FindingRef>();

  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {}

  get record(): ScanRecord | undefined {
    return this._record;
  }

  get filter(): SeverityFilter {
    return this._filter;
  }

  restore(): void {
    const saved = this.memento.get<ScanRecord>(STORAGE_KEY);
    if (saved && Array.isArray(saved.findings)) {
      this._record = saved;
      this.publishDiagnostics();
    }
  }

  setFilter(filter: SeverityFilter): void {
    if (this._filter === filter) {
      return;
    }
    this._filter = filter;
    this._onDidChange.fire();
  }

  setRecord(record: ScanRecord): void {
    this._record = record;
    void this.memento.update(STORAGE_KEY, record);
    this.publishDiagnostics();
    this._onDidChange.fire();
  }

  /**
   * Replace findings for a single scanned file while keeping results for the
   * rest of the workspace. Used by "scan on save".
   */
  mergeFileScan(record: ScanRecord): void {
    if (!this._record) {
      this.setRecord(record);
      return;
    }
    const target = path.resolve(record.target);
    const kept = this._record.findings.filter((finding) => {
      const uri = resolveFindingUri(this._record!.root, finding.file);
      return path.resolve(uri.fsPath) !== target;
    });
    this.setRecord({
      ...this._record,
      findings: [...kept, ...record.findings],
      files_scanned: Math.max(this._record.files_scanned, record.files_scanned),
      errors: record.errors,
      scannedAt: record.scannedAt,
      reportPath: record.reportPath,
    });
  }

  clear(): void {
    this._record = undefined;
    this.index.clear();
    this.diagnostics.clear();
    void this.memento.update(STORAGE_KEY, undefined);
    this._onDidChange.fire();
  }

  /** All findings, resolved to URIs, optionally applying the severity filter. */
  refs(applyFilter = false): FindingRef[] {
    const record = this._record;
    if (!record) {
      return [];
    }
    return record.findings
      .filter((finding) => {
        if (!applyFilter || this._filter === "all") {
          return true;
        }
        return (finding.severity ?? "").toLowerCase() === this._filter;
      })
      .map((finding) => ({
        finding,
        uri: resolveFindingUri(record.root, finding.file),
      }));
  }

  /** Look up the finding behind a diagnostic (used for code actions). */
  findingFor(diagnostic: vscode.Diagnostic, uri: vscode.Uri): FindingRef | undefined {
    const line = diagnostic.range.start.line;
    return this.index.get(indexKey(uri, line, diagnostic.message));
  }

  republish(): void {
    this.publishDiagnostics();
  }

  private publishDiagnostics(): void {
    this.diagnostics.clear();
    this.index.clear();

    const record = this._record;
    if (!record) {
      return;
    }

    const threshold = vscode.workspace
      .getConfiguration("cyclon")
      .get<string>("severityThreshold", "info");
    const maxRank = severityRank(threshold);

    const byFile = new Map<string, vscode.Diagnostic[]>();

    for (const ref of this.refs()) {
      const finding = ref.finding;
      if (severityRank(finding.severity) > maxRank) {
        continue;
      }

      const line = Math.max(1, Number(finding.line) || 1) - 1;
      const range = new vscode.Range(line, 0, line, 1000);
      const message = buildDiagnosticMessage(finding);

      const diagnostic = new vscode.Diagnostic(
        range,
        message,
        toDiagnosticSeverity(finding.severity),
      );
      diagnostic.source = "cyclon";
      if (finding.category) {
        diagnostic.code = finding.category;
      }
      this.index.set(indexKey(ref.uri, line, message), ref);

      const list = byFile.get(ref.uri.fsPath) ?? [];
      list.push(diagnostic);
      byFile.set(ref.uri.fsPath, list);
    }

    for (const [fsPath, list] of byFile) {
      this.diagnostics.set(vscode.Uri.file(fsPath), list);
    }
  }
}

function indexKey(uri: vscode.Uri, zeroBasedLine: number, message: string): string {
  return `${uri.fsPath}|${zeroBasedLine}|${message}`;
}
