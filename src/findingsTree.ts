import * as vscode from "vscode";

import type { FindingRef } from "./store";
import type { ScanStore } from "./store";
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
