import * as vscode from "vscode";

import type { FindingRef } from "./store";
import type { ScanStore } from "./store";
import { SEVERITIES, type Severity } from "./types";
import {
  findingLocation,
  relativeTime,
  severityIcon,
  severityRank,
  truncate,
} from "./util";

type NodeKind = "message" | "file" | "finding";

class FindingsNode extends vscode.TreeItem {
  kind: NodeKind;
  children: FindingRef[] | undefined;
  ref: FindingRef | undefined;

  constructor(kind: NodeKind, label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(label, collapsibleState);
    this.kind = kind;
  }
}

export class FindingsProvider implements vscode.TreeDataProvider<FindingsNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<FindingsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: ScanStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(element: FindingsNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FindingsNode): FindingsNode[] {
    if (!element) {
      return this.rootNodes();
    }
    if (element.kind === "file") {
      return (element.children ?? []).map((ref) => this.findingNode(ref));
    }
    return [];
  }

  private rootNodes(): FindingsNode[] {
    const refs = this.store.refs(true);

    if (refs.length === 0) {
      const record = this.store.record;
      const label = !record
        ? "No scan yet — run “Cyclon: Scan Workspace”"
        : this.store.filter === "all"
          ? "No issues found 🎉"
          : `No ${this.store.filter} issues`;
      const node = new FindingsNode("message", label, vscode.TreeItemCollapsibleState.None);
      node.iconPath = new vscode.ThemeIcon(record ? "pass" : "info");
      node.tooltip = record
        ? `Scanned ${record.files_scanned} file(s) ${relativeTime(record.scannedAt)}`
        : "Cyclon scans your code with the xAI Grok API.";
      return [node];
    }

    const groups = new Map<string, FindingRef[]>();
    for (const ref of refs) {
      const list = groups.get(ref.uri.fsPath) ?? [];
      list.push(ref);
      groups.set(ref.uri.fsPath, list);
    }

    const ordered = [...groups.entries()].sort((a, b) => {
      const severity = worstRank(a[1]) - worstRank(b[1]);
      return severity !== 0 ? severity : a[0].localeCompare(b[0]);
    });

    return ordered.map(([fsPath, items]) => {
      const uri = vscode.Uri.file(fsPath);
      const node = new FindingsNode(
        "file",
        vscode.workspace.asRelativePath(uri, false),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      node.children = [...items].sort(
        (a, b) =>
          severityRank(a.finding.severity) - severityRank(b.finding.severity) ||
          (a.finding.line ?? 0) - (b.finding.line ?? 0),
      );
      node.resourceUri = uri;
      node.description = `${items.length}`;
      node.tooltip = `${items.length} issue(s) in ${fsPath}`;
      return node;
    });
  }

  private findingNode(ref: FindingRef): FindingsNode {
    const finding = ref.finding;
    const node = new FindingsNode(
      "finding",
      truncate(finding.title || finding.category || "Issue", 90),
      vscode.TreeItemCollapsibleState.None,
    );
    node.ref = ref;
    node.description = finding.line ? `:${finding.line}` : "";
    node.iconPath = severityIcon(finding.severity);
    node.contextValue = "cyclonFinding";
    node.tooltip = this.tooltip(ref);
    node.command = {
      command: "cyclon.openFinding",
      title: "Go to finding",
      arguments: [ref],
    };
    return node;
  }

  private tooltip(ref: FindingRef): vscode.MarkdownString {
    const finding = ref.finding;
    const record = this.store.record;
    const location = record ? findingLocation(finding, record.root) : finding.file;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMarkdown(finding.title || "Issue")}**  \n`);
    md.appendMarkdown(`\`${escapeMarkdown(location)}\`  \n`);
    md.appendMarkdown(
      `Severity: **${(finding.severity || "info").toUpperCase()}** · ${escapeMarkdown(
        finding.category || "bug",
      )}`,
    );
    if (finding.agent) {
      md.appendMarkdown(`  \nAgents: ${escapeMarkdown(finding.agent)}`);
    }
    if (finding.description) {
      md.appendMarkdown(`\n\n${escapeMarkdown(finding.description)}`);
    }
    if (finding.suggestion) {
      md.appendMarkdown(`\n\n**Suggested fix**\n\n\`\`\`\n${finding.suggestion}\n\`\`\``);
    }
    return md;
  }
}

function worstRank(items: FindingRef[]): number {
  return items.reduce((worst, item) => Math.min(worst, severityRank(item.finding.severity)), 9);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+|>]/g, (char) => `\\${char}`);
}

class ErrorGroupItem extends vscode.TreeItem {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Errors (${errors.length})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.errors = errors;
    this.iconPath = new vscode.ThemeIcon(
      "warning",
      new vscode.ThemeColor("problemsWarningIcon.foreground"),
    );
    this.tooltip = "Files or agents that failed during the scan";
  }
}

export class OverviewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    vscode.TreeItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: ScanStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof ErrorGroupItem) {
      return element.errors.map((message) => {
        const item = new vscode.TreeItem(truncate(message, 120), vscode.TreeItemCollapsibleState.None);
        item.tooltip = message;
        item.iconPath = new vscode.ThemeIcon("warning");
        return item;
      });
    }

    const record = this.store.record;
    if (!record) {
      const item = new vscode.TreeItem("No scan yet", vscode.TreeItemCollapsibleState.None);
      item.description = "run “Cyclon: Scan Workspace”";
      item.iconPath = new vscode.ThemeIcon("info");
      return [item];
    }

    const counts = countSeverities(record);
    const items: vscode.TreeItem[] = [];

    const total = new vscode.TreeItem(
      `${record.findings.length} issue(s)`,
      vscode.TreeItemCollapsibleState.None,
    );
    total.description = `${record.files_scanned} file(s)`;
    total.iconPath = new vscode.ThemeIcon("shield");
    total.tooltip = `Target: ${record.target}`;
    items.push(total);

    const last = new vscode.TreeItem("Last scan", vscode.TreeItemCollapsibleState.None);
    last.description = relativeTime(record.scannedAt);
    last.iconPath = new vscode.ThemeIcon("history");
    last.tooltip = new vscode.MarkdownString(
      `Target: \`${record.target}\`\n\nReport: \`${record.reportPath}\``,
    );
    last.command = { command: "cyclon.showReport", title: "Open report" };
    items.push(last);

    for (const severity of SEVERITIES) {
      const item = new vscode.TreeItem(severity, vscode.TreeItemCollapsibleState.None);
      const count = counts[severity] ?? 0;
      const active = this.store.filter === severity;
      item.description = active ? `${count} · filtered` : `${count}`;
      item.iconPath = severityIcon(severity);
      item.tooltip = `Show only ${severity} findings`;
      item.command = {
        command: "cyclon.filterSeverity",
        title: "Filter findings",
        arguments: [severity],
      };
      items.push(item);
    }

    if (this.store.filter !== "all") {
      const clear = new vscode.TreeItem("Clear filter", vscode.TreeItemCollapsibleState.None);
      clear.description = `showing ${this.store.filter}`;
      clear.iconPath = new vscode.ThemeIcon("filter");
      clear.command = {
        command: "cyclon.filterSeverity",
        title: "Clear filter",
        arguments: ["all"],
      };
      items.push(clear);
    }

    if (record.errors.length > 0) {
      items.push(new ErrorGroupItem(record.errors));
    }

    return items;
  }
}

function countSeverities(record: { findings: { severity: string }[] }): Record<Severity, number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<Severity, number>;
  for (const finding of record.findings) {
    const severity = (finding.severity ?? "").toLowerCase() as Severity;
    if (severity in counts) {
      counts[severity] += 1;
    } else {
      counts.info += 1;
    }
  }
  return counts;
}
