import * as vscode from "vscode";

import type { FindingRef } from "./store";
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
      ? `<div class="block"><div class="block-head"><span>Suggested fix</span><button id="copy" class="mini">Copy</button></div><pre>${escapeHtml(finding.suggestion)}</pre></div>`
      : "";
    const copyButton = finding.suggestion
      ? '<button class="secondary" id="copy2">Copy fix</button>'
      : "";

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --accent: #ff6c37;
    --line: rgba(255,255,255,.08);
    --panel: var(--vscode-editorWidget-background, #1a1e28);
    --panel-2: rgba(255,255,255,.045);
    --muted: var(--vscode-descriptionForeground, #8b93a7);
    --text: var(--vscode-foreground, #e7e9ee);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--text);
    margin: 0;
    padding: 0;
    line-height: 1.55;
  }
  .wrap { max-width: 860px; padding: 22px 26px 44px; }
  .top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .severity {
    display: inline-block;
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    padding: 3px 9px;
    border-radius: 4px;
    color: #0f1117;
  }
  .critical { background: #f87171; }
  .high { background: #fb923c; }
  .medium { background: #fbbf24; }
  .low { background: #60a5fa; }
  .info { background: #94a3b8; }
  .category {
    font-size: 10.5px; color: var(--muted); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px;
  }
  h1 { font-size: 21px; margin: 8px 0 10px; letter-spacing: -.3px; line-height: 1.3; }
  .loc {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: var(--vscode-editor-font-family);
    font-size: 11.5px; color: #9fb3d1;
    background: rgba(96,165,250,.09);
    border: 1px solid rgba(96,165,250,.18);
    border-radius: 5px; padding: 3px 8px; cursor: pointer;
  }
  .loc:hover { background: rgba(96,165,250,.16); }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; }
  .tag { font-size: 10px; color: var(--muted); background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px; }
  h2 {
    font-size: 10px; text-transform: uppercase; letter-spacing: .1em;
    color: var(--muted); margin: 26px 0 8px; font-weight: 700;
  }
  p { white-space: pre-wrap; margin: 0; color: #c6cddb; }
  .block {
    border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-top: 10px;
  }
  .block-head {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    background: var(--panel-2); padding: 6px 10px;
    font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 700;
  }
  pre {
    margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-word;
    background: var(--vscode-textCodeBlock-background, #0c0f15);
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    color: #d6e2f0; overflow: auto;
  }
  .actions { margin-top: 26px; display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    font-family: inherit; font-size: 12px; font-weight: 600;
    border: 1px solid transparent; border-radius: 6px; padding: 7px 15px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button:hover { filter: brightness(1.12); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border-color: var(--line);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); filter: none; }
  button.mini {
    font-size: 10px; padding: 2px 9px; border-radius: 4px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <span class="severity ${severity}">${escapeHtml(severity)}</span>
    <span class="category">${escapeHtml(finding.category || "bug")}</span>
  </div>
  <h1>${escapeHtml(title)}</h1>
  <span class="loc" id="goto">▤ ${escapeHtml(location)}${escapeHtml(lineSuffix)}</span>
  <div class="meta">
    ${finding.agent ? `<span class="tag">agent: ${escapeHtml(finding.agent)}</span>` : ""}
    <span class="tag">source: cyclon</span>
  </div>
  <h2>Description</h2>
  <p>${escapeHtml(finding.description || "No description provided.")}</p>
  ${suggestion}
  <div class="actions">
    <button id="goto2">Go to line</button>
    ${copyButton}
  </div>
</div>
<script nonce="${scriptNonce}">
  const vscode = acquireVsCodeApi();
  const goto = () => vscode.postMessage({ type: 'goto' });
  document.getElementById('goto').addEventListener('click', goto);
  document.getElementById('goto2').addEventListener('click', goto);
  for (const id of ['copy', 'copy2']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  }
</script>
</body>
</html>`;
  }
}
