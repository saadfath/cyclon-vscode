import * as fs from "node:fs";

import * as vscode from "vscode";

import type { FindingRef } from "./store";
import type { ScanRecord } from "./types";
import { escapeHtml, normalizeSeverity, truncate } from "./util";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

export class FindingDetailPanel {
  private static current: FindingDetailPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private ref: FindingRef,
  ) {
    panel.onDidDispose(() => {
      if (FindingDetailPanel.current === this) {
        FindingDetailPanel.current = undefined;
      }
    });
    panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      void this.handleMessage(message);
    });
    this.render();
  }

  static show(ref: FindingRef): void {
    if (FindingDetailPanel.current) {
      const existing = FindingDetailPanel.current;
      existing.ref = ref;
      existing.render();
      existing.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "cyclon.finding",
      "Cyclon Finding",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    FindingDetailPanel.current = new FindingDetailPanel(panel, ref);
  }

  private async handleMessage(message: { type?: string }): Promise<void> {
    if (message.type === "goto") {
      const line = Math.max(0, (Number(this.ref.finding.line) || 1) - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const document = await vscode.workspace.openTextDocument(this.ref.uri);
      const editor = await vscode.window.showTextDocument(document, {
        preview: true,
        selection: range,
      });
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }

    if (message.type === "copy") {
      const suggestion = this.ref.finding.suggestion;
      if (!suggestion) {
        void vscode.window.showInformationMessage("Cyclon: this finding has no suggested fix.");
        return;
      }
      await vscode.env.clipboard.writeText(suggestion);
      void vscode.window.showInformationMessage("Cyclon: suggested fix copied to the clipboard.");
    }
  }

  private render(): void {
    const finding = this.ref.finding;
    const severity = normalizeSeverity(finding.severity);
    const location = vscode.workspace.asRelativePath(this.ref.uri, false);
    const lineSuffix = finding.line ? `:${finding.line}` : "";
    const scriptNonce = nonce();
    const title = finding.title || finding.category || "Issue";

    this.panel.title = truncate(`Cyclon: ${title}`, 48);

    const suggestion = finding.suggestion
      ? `<h2>Suggested fix</h2><pre>${escapeHtml(finding.suggestion)}</pre>`
      : "";
    const copyButton = finding.suggestion
      ? '<button id="copy" class="secondary">Copy fix</button>'
      : "";

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 18px 22px 40px;
    line-height: 1.55;
  }
  .severity {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 3px 9px;
    border-radius: 999px;
    color: #fff;
  }
  .critical, .high { background: var(--vscode-problemsErrorIcon-foreground, #e5534b); }
  .medium { background: var(--vscode-problemsWarningIcon-foreground, #cca700); }
  .low, .info { background: var(--vscode-problemsInfoIcon-foreground, #3794ff); }
  h1 { font-size: 20px; margin: 12px 0 6px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 22px 0 8px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 4px; }
  .meta code, code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 2px 5px; border-radius: 4px; }
  p { white-space: pre-wrap; margin: 0; }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 6px;
    padding: 12px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    overflow: auto;
  }
  .actions { margin-top: 24px; display: flex; gap: 8px; }
  button {
    font-family: inherit;
    font-size: 12px;
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
</style>
</head>
<body>
  <span class="severity ${severity}">${escapeHtml(severity)}</span>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    <code>${escapeHtml(location)}${escapeHtml(lineSuffix)}</code>
    &nbsp;·&nbsp; ${escapeHtml(finding.category || "bug")}
    ${finding.agent ? `&nbsp;·&nbsp; ${escapeHtml(finding.agent)}` : ""}
  </div>
  <h2>Description</h2>
  <p>${escapeHtml(finding.description || "No description provided.")}</p>
  ${suggestion}
  <div class="actions">
    <button id="goto">Go to line</button>
    ${copyButton}
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('goto').addEventListener('click', () => vscode.postMessage({ type: 'goto' }));
    const copy = document.getElementById('copy');
    if (copy) copy.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  </script>
</body>
</html>`;
  }
}

export class ReportPanel {
  private static current: ReportPanel | undefined;

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => {
      if (ReportPanel.current === this) {
        ReportPanel.current = undefined;
      }
    });
  }

  static show(record: ScanRecord): void {
    if (!record.reportPath || !fs.existsSync(record.reportPath)) {
      void vscode.window.showInformationMessage(
        "Cyclon: no HTML report is available. Run a scan first.",
      );
      return;
    }

    const html = fs.readFileSync(record.reportPath, "utf8");

    if (ReportPanel.current) {
      ReportPanel.current.panel.webview.html = html;
      ReportPanel.current.panel.reveal(undefined, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "cyclon.report",
      "Cyclon Report",
      vscode.ViewColumn.Active,
      // The report is generated locally by the cyclon CLI and contains inline
      // styles and scripts only.
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = html;
    ReportPanel.current = new ReportPanel(panel);
  }
}
