import * as fs from "node:fs";

import * as vscode from "vscode";

import type { CyclonEvent } from "./events";
import type { ScanStore } from "./store";
import type { Finding, ScanRecord, Severity } from "./types";
import { normalizeSeverity, resolveFindingUri } from "./util";

type Phase = "idle" | "scanning" | "done" | "error";

interface AgentState {
  name: string;
  files: number;
  findings: number;
  active: string | null;
}

interface FeedItem {
  id: number;
  kind: "info" | "file" | "finding" | "error" | "done";
  text: string;
  detail?: string;
  severity?: string;
  at: number;
  file?: string;
  line?: number | null;
}

const MAX_FEED = 150;

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

export class DashboardProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "cyclon.dashboard";

  private view: vscode.WebviewView | undefined;
  private phase: Phase = "idle";
  private target = "";
  private root = "";
  private totalFiles = 0;
  private doneFiles = 0;
  private findings: Finding[] = [];
  private errors = 0;
  private agents = new Map<string, AgentState>();
  private feed: FeedItem[] = [];
  private feedId = 0;
  private startedAt = 0;
  private finishedAt = 0;
  private syncedAt = 0;
  private message = "";
  private reportPath = "";

  constructor(private readonly store: ScanStore) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postState();
      }
    });
    this.postState();
  }

  /** Reset for a new scan and show the live state immediately. */
  start(label: string, target: string): void {
    this.phase = "scanning";
    this.target = label;
    this.root = target;
    this.totalFiles = 0;
    this.doneFiles = 0;
    this.findings = [];
    this.errors = 0;
    this.agents.clear();
    this.feed = [];
    this.feedId = 0;
    this.startedAt = Date.now();
    this.finishedAt = 0;
    this.syncedAt = 0;
    this.message = "";
    this.reportPath = "";
    this.pushFeed("info", `Starting scan of ${label}…`);
    this.postState();
  }

  handleEvent(event: CyclonEvent): void {
    switch (event.type) {
      case "start": {
        this.phase = "scanning";
        this.root = event.root || this.root;
        this.totalFiles = Number(event.files) || 0;
        if (!this.startedAt) {
          this.startedAt = Date.now();
        }
        for (const name of event.agents ?? []) {
          this.agent(name);
        }
        const models = event.models && event.models.length > 0 ? ` · ${event.models[0]}` : "";
        this.pushFeed(
          "info",
          `${this.totalFiles} file(s) queued for ${this.agents.size || 1} agent(s)${models}`,
        );
        break;
      }
      case "file_start": {
        const agent = this.agent(event.agent);
        agent.active = event.file;
        this.pushFeed("file", event.file, event.agent);
        break;
      }
      case "finding": {
        const agent = this.agent(event.agent);
        agent.findings += 1;
        if (event.finding) {
          this.findings.push(event.finding);
          this.pushFeed(
            "finding",
            event.finding.title || "Issue",
            `${event.file}${event.finding.line ? `:${event.finding.line}` : ""} · ${event.agent}`,
            event.finding.severity,
            event.file,
            event.finding.line,
          );
        }
        break;
      }
      case "file_done": {
        const agent = this.agent(event.agent);
        agent.active = null;
        agent.files += 1;
        this.doneFiles = Math.min(
          this.totalFiles || this.doneFiles + 1,
          [...this.agents.values()].reduce((sum, item) => sum + item.files, 0),
        );
        if (event.count > 0) {
          this.pushFeed(
            event.cached ? "info" : "file",
            `${event.file} · ${event.count} finding(s)${event.cached ? " (cached)" : ""}`,
            event.agent,
          );
        }
        break;
      }
      case "error": {
        this.errors += 1;
        const agent = this.agent(event.agent);
        agent.active = null;
        this.pushFeed("error", event.message, `${event.file} · ${event.agent}`);
        break;
      }
      case "done": {
        this.doneFiles = this.totalFiles || event.files_scanned || this.doneFiles;
        for (const agent of this.agents.values()) {
          agent.active = null;
        }
        this.pushFeed(
          "done",
          `Finished ${event.files_scanned} file(s) · ${event.findings} finding(s)`,
          event.errors > 0 ? `${event.errors} error(s)` : undefined,
        );
        break;
      }
    }
    this.postState();
  }

  /** Finalise with the authoritative scan result. */
  finish(record: ScanRecord): void {
    this.phase = "done";
    this.finishedAt = Date.now();
    this.syncedAt = record.scannedAt;
    this.findings = record.findings;
    this.errors = record.errors.length;
    this.totalFiles = record.files_scanned;
    this.doneFiles = record.files_scanned;
    this.reportPath = record.reportPath;
    this.root = record.root || this.root;
    for (const name of record.agents ?? []) {
      this.agent(name);
    }
    for (const agent of this.agents.values()) {
      agent.active = null;
    }
    this.pushFeed(
      "done",
      `Scan complete · ${record.findings.length} finding(s) in ${record.files_scanned} file(s)`,
      record.durationMs ? `${(record.durationMs / 1000).toFixed(1)}s` : undefined,
    );
    this.postState();
  }

  fail(message: string): void {
    this.phase = "error";
    this.finishedAt = Date.now();
    this.message = message;
    for (const agent of this.agents.values()) {
      agent.active = null;
    }
    this.pushFeed("error", message);
    this.postState();
  }

  cancel(): void {
    if (this.phase === "scanning") {
      this.phase = "idle";
      this.finishedAt = Date.now();
      this.pushFeed("info", "Scan cancelled");
      this.postState();
    }
  }

  /** Refresh idle/done state from the store (restore, clear, filter changes). */
  sync(): void {
    if (this.phase === "scanning") {
      return;
    }
    const record = this.store.record;
    if (!record) {
      this.phase = "idle";
      this.target = "";
      this.root = "";
      this.findings = [];
      this.errors = 0;
      this.totalFiles = 0;
      this.doneFiles = 0;
      this.agents.clear();
      this.feed = [];
      this.reportPath = "";
      this.startedAt = 0;
      this.finishedAt = 0;
      this.syncedAt = 0;
      this.message = "";
    } else {
      const sameScan = record.scannedAt === this.syncedAt;
      this.phase = "done";
      this.target = record.target;
      this.root = record.root || record.target;
      this.findings = record.findings;
      this.errors = record.errors.length;
      this.totalFiles = record.files_scanned;
      this.doneFiles = record.files_scanned;
      this.reportPath = record.reportPath;
      this.startedAt = record.scannedAt - (record.durationMs ?? 0);
      this.finishedAt = record.scannedAt;
      this.syncedAt = record.scannedAt;
      this.agents.clear();
      for (const name of record.agents ?? []) {
        this.agent(name);
      }
      if (!sameScan) {
        this.feed = [];
      }
    }
    this.postState();
  }

  private agent(name: string): AgentState {
    const key = name || "Agent";
    let state = this.agents.get(key);
    if (!state) {
      state = { name: key, files: 0, findings: 0, active: null };
      this.agents.set(key, state);
    }
    return state;
  }

  private pushFeed(
    kind: FeedItem["kind"],
    text: string,
    detail?: string,
    severity?: string,
    file?: string,
    line?: number | null,
  ): void {
    this.feedId += 1;
    this.feed.unshift({
      id: this.feedId,
      kind,
      text: String(text ?? "").trim() || "—",
      detail,
      severity,
      at: Date.now(),
      file,
      line,
    });
    if (this.feed.length > MAX_FEED) {
      this.feed.length = MAX_FEED;
    }
  }

  private state() {
    const severity: Record<Severity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    for (const finding of this.findings) {
      severity[normalizeSeverity(finding.severity)] += 1;
    }

    const record = this.store.record;
    const hasReport = Boolean(this.reportPath) && fs.existsSync(this.reportPath);

    return {
      phase: this.phase,
      target: this.target,
      totalFiles: this.totalFiles,
      doneFiles: this.doneFiles,
      findings: this.findings.length,
      errors: this.errors,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      agents: [...this.agents.values()],
      feed: this.feed,
      severity,
      filter: this.store.filter,
      hasReport,
      message: this.message,
      record: record
        ? {
            files: record.files_scanned,
            findings: record.findings.length,
            scannedAt: record.scannedAt,
            durationMs: record.durationMs,
          }
        : undefined,
    };
  }

  private postState(): void {
    void this.view?.webview.postMessage({ type: "state", state: this.state() });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const message = raw as {
      type?: string;
      command?: string;
      value?: string;
      file?: string;
      line?: number;
    };

    if (message.type === "command" && typeof message.command === "string") {
      if (message.command === "cyclon.cancelScan") {
        this.cancel();
      }
      await vscode.commands.executeCommand(message.command);
      return;
    }

    if (message.type === "filter" && typeof message.value === "string") {
      await vscode.commands.executeCommand("cyclon.filterSeverity", message.value);
      return;
    }

    if (message.type === "open" && typeof message.file === "string") {
      const base = this.root || this.store.record?.root || this.store.record?.target || "";
      const uri = resolveFindingUri(base, message.file);
      const line = Math.max(0, (Number(message.line) || 1) - 1);
      const range = new vscode.Range(line, 0, line, 0);
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
          preview: true,
          selection: range,
        });
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      } catch {
        void vscode.window.showWarningMessage(`Cyclon: cannot open ${message.file}.`);
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${scriptNonce}'`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --accent: #38bdf8;
    --accent-2: #a78bfa;
    --critical: #f87171;
    --high: #fb923c;
    --medium: #fbbf24;
    --low: #60a5fa;
    --info: #94a3b8;
    --ok: #34d399;
    --card: var(--vscode-sideBar-background, #181818);
    --line: var(--vscode-panel-border, rgba(255,255,255,.08));
    --muted: var(--vscode-descriptionForeground, #9ca3af);
    --text: var(--vscode-foreground, #e5e7eb);
    --surface: var(--vscode-editorWidget-background, #202020);
    --hover: var(--vscode-list-hoverBackground, rgba(255,255,255,.06));
    --btn: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #fff);
    --btn2: var(--vscode-button-secondaryBackground, rgba(255,255,255,.08));
    --btn2-fg: var(--vscode-button-secondaryForeground, #e5e7eb);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: 12px;
    color: var(--text);
    background: var(--card);
    line-height: 1.45;
  }
  .wrap { padding: 12px 12px 24px; display: flex; flex-direction: column; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 9px; }
  .logo {
    width: 30px; height: 30px; flex: none;
    display: grid; place-items: center;
    border-radius: 9px;
    background: linear-gradient(135deg, rgba(56,189,248,.22), rgba(167,139,250,.22));
    border: 1px solid rgba(56,189,248,.35);
    font-size: 15px; color: var(--accent);
  }
  .brand-text { min-width: 0; flex: 1; }
  .title { font-size: 14px; font-weight: 700; letter-spacing: .2px; }
  .subtitle {
    font-size: 10.5px; color: var(--muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 190px;
  }
  .pill {
    flex: none; font-size: 9.5px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; padding: 3px 8px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted);
    background: rgba(255,255,255,.03);
  }
  .pill.scanning { color: var(--accent); border-color: rgba(56,189,248,.45); background: rgba(56,189,248,.1); }
  .pill.done { color: var(--ok); border-color: rgba(52,211,153,.4); background: rgba(52,211,153,.1); }
  .pill.error { color: var(--critical); border-color: rgba(248,113,113,.4); background: rgba(248,113,113,.1); }

  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .stat {
    background: var(--surface); border: 1px solid var(--line); border-radius: 9px;
    padding: 8px 9px; text-align: left;
  }
  .stat .num { font-size: 19px; font-weight: 700; letter-spacing: -.3px; font-variant-numeric: tabular-nums; }
  .stat .lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
  .stat.findings .num { color: var(--accent); }
  .stat.errors .num { color: var(--critical); }

  .progress {
    height: 5px; border-radius: 999px; overflow: hidden;
    background: rgba(255,255,255,.08);
  }
  .bar {
    height: 100%; width: 0%; border-radius: 999px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: width .35s ease;
  }
  .bar.indeterminate {
    width: 35% !important;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide {
    0% { margin-left: -35%; }
    100% { margin-left: 100%; }
  }
  .progress-meta {
    display: flex; justify-content: space-between; gap: 8px;
    font-size: 10.5px; color: var(--muted); margin-top: -6px;
  }
  .progress-meta span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .section-head {
    display: flex; justify-content: space-between; align-items: baseline;
    font-size: 9.5px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--muted); font-weight: 700; margin-bottom: 7px;
  }

  .agents { display: flex; flex-direction: column; gap: 6px; }
  .agent {
    display: flex; align-items: center; gap: 8px;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: 8px; padding: 6px 9px;
  }
  .agent .dot {
    width: 7px; height: 7px; border-radius: 50%; flex: none;
    background: var(--muted);
  }
  .agent.working { border-color: rgba(56,189,248,.4); }
  .agent.working .dot { background: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
  .agent.done .dot { background: var(--ok); }
  @keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.75); } }
  .agent-name { flex: 1; min-width: 0; font-weight: 600; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-meta { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
  .agent-active {
    font-size: 9.5px; color: var(--accent); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; max-width: 130px;
  }

  .sev { display: flex; flex-wrap: wrap; gap: 5px; }
  .sev button {
    display: inline-flex; align-items: center; gap: 5px;
    font-family: inherit; font-size: 10px; font-weight: 600;
    color: var(--text); background: var(--surface);
    border: 1px solid var(--line); border-radius: 999px;
    padding: 3px 8px; cursor: pointer;
  }
  .sev button:hover { background: var(--hover); }
  .sev button.active { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(56,189,248,.35) inset; }
  .sev .swatch { width: 6px; height: 6px; border-radius: 50%; }
  .sev .count { color: var(--muted); font-variant-numeric: tabular-nums; }
  .sev button.active .count { color: var(--text); }

  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  button.act {
    font-family: inherit; font-size: 11px; font-weight: 600;
    border: 1px solid transparent; border-radius: 6px;
    padding: 7px 8px; cursor: pointer;
    color: var(--btn-fg); background: var(--btn);
  }
  button.act:hover { filter: brightness(1.12); }
  button.act.ghost {
    color: var(--btn2-fg); background: var(--btn2); border-color: var(--line);
  }
  button.act.ghost:hover { background: var(--hover); filter: none; }
  button.act.danger { color: #fff; background: #b91c1c; }
  button.act[disabled] { opacity: .45; cursor: default; filter: none; }

  .feed-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 1px;
    max-height: 320px; overflow-y: auto;
    border: 1px solid var(--line); border-radius: 8px;
    background: var(--surface);
  }
  .feed-list:empty::after {
    content: "Waiting for scan activity…";
    display: block; padding: 14px; text-align: center;
    color: var(--muted); font-size: 11px;
  }
  .feed-item {
    display: flex; align-items: flex-start; gap: 7px;
    padding: 6px 9px; border-bottom: 1px solid var(--line);
    animation: fade .25s ease;
  }
  .feed-item:last-child { border-bottom: none; }
  @keyframes fade { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
  .feed-item .ico { flex: none; width: 13px; text-align: center; font-size: 10px; line-height: 1.5; }
  .feed-item .body { flex: 1; min-width: 0; }
  .feed-item .txt {
    font-size: 11px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
  }
  .feed-item .det {
    font-size: 9.5px; color: var(--muted); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .feed-item .time {
    flex: none; font-size: 9.5px; color: var(--muted);
    font-variant-numeric: tabular-nums; padding-top: 1px;
  }
  .feed-item.finding { cursor: pointer; }
  .feed-item.finding:hover { background: var(--hover); }
  .feed-item.error .txt { color: var(--critical); }
  .feed-item.done .txt { color: var(--ok); }
  .feed-item.file .ico { color: var(--accent); }
  .feed-item.finding .ico { color: var(--medium); }
  .feed-item.error .ico { color: var(--critical); }
  .feed-item.done .ico { color: var(--ok); }

  .banner {
    border: 1px solid rgba(248,113,113,.4); background: rgba(248,113,113,.1);
    color: var(--critical); border-radius: 8px; padding: 8px 10px; font-size: 11px;
  }
  .hidden { display: none !important; }
  .empty-hint { font-size: 10.5px; color: var(--muted); text-align: center; padding: 2px 0; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">
    <div class="logo">◈</div>
    <div class="brand-text">
      <div class="title">Cyclon</div>
      <div class="subtitle" id="target">Multi-agent code scanner</div>
    </div>
    <span class="pill" id="phase">Idle</span>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="num" id="stat-files">0</div>
      <div class="lbl">Files</div>
    </div>
    <div class="stat findings">
      <div class="num" id="stat-findings">0</div>
      <div class="lbl">Findings</div>
    </div>
    <div class="stat" id="stat-time-card">
      <div class="num" id="stat-time">0:00</div>
      <div class="lbl">Elapsed</div>
    </div>
  </div>

  <div class="progress"><div class="bar" id="bar"></div></div>
  <div class="progress-meta">
    <span id="progress-text">Ready to scan</span>
    <span id="progress-pct"></span>
  </div>

  <div class="banner hidden" id="banner"></div>

  <section>
    <div class="section-head"><span>Agents</span><span id="agent-count"></span></div>
    <div class="agents" id="agents">
      <div class="empty-hint">Agents appear when a scan starts.</div>
    </div>
  </section>

  <section>
    <div class="section-head"><span>Severity</span><span id="error-count"></span></div>
    <div class="sev" id="sev"></div>
  </section>

  <section class="actions">
    <button class="act" data-command="cyclon.scanWorkspace">Scan Workspace</button>
    <button class="act ghost" data-command="cyclon.scanFile">Scan File</button>
    <button class="act danger hidden" id="cancel" data-command="cyclon.cancelScan">Cancel Scan</button>
    <button class="act ghost" id="report" data-command="cyclon.showReport" disabled>Open Report</button>
  </section>

  <section>
    <div class="section-head"><span>Live activity</span><span id="feed-count"></span></div>
    <ul class="feed-list" id="feed"></ul>
  </section>
</div>

<script nonce="${scriptNonce}">
  const vscode = acquireVsCodeApi();
  const SEVERITIES = ["critical", "high", "medium", "low", "info"];
  const SEV_COLORS = {
    critical: "var(--critical)", high: "var(--high)", medium: "var(--medium)",
    low: "var(--low)", info: "var(--info)",
  };
  const ICONS = { info: "›", file: "▤", finding: "◆", error: "✕", done: "✓" };
  const $ = (id) => document.getElementById(id);
  let state = null;
  let ticker = null;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function elapsed() {
    if (!state) return 0;
    if (state.phase === "scanning" || !state.finishedAt) {
      return state.startedAt ? Date.now() - state.startedAt : 0;
    }
    return Math.max(0, state.finishedAt - state.startedAt);
  }

  function render() {
    if (!state) return;
    const scanning = state.phase === "scanning";

    $("phase").textContent = state.phase === "scanning" ? "Scanning"
      : state.phase === "done" ? "Complete" : state.phase === "error" ? "Error" : "Idle";
    $("phase").className = "pill " + state.phase;

    $("target").textContent = state.target || "Multi-agent code scanner";
    $("target").title = state.target || "";

    $("stat-files").textContent = scanning && state.totalFiles === 0
      ? "…" : String(state.doneFiles) + (state.totalFiles ? "/" + state.totalFiles : "");
    $("stat-findings").textContent = String(state.findings);
    $("stat-time").textContent = fmtTime(elapsed());

    const pct = state.totalFiles > 0 ? Math.min(100, (state.doneFiles / state.totalFiles) * 100) : 0;
    const bar = $("bar");
    bar.classList.toggle("indeterminate", scanning && state.totalFiles === 0);
    bar.style.width = (state.totalFiles > 0 ? pct : 0) + "%";
    $("progress-pct").textContent = state.totalFiles > 0 ? Math.round(pct) + "%" : "";
    $("progress-text").textContent = scanning
      ? (state.totalFiles > 0
          ? "Scanning " + state.doneFiles + " of " + state.totalFiles + " files"
          : "Discovering files…")
      : state.phase === "done"
        ? "Last scan: " + state.findings + " finding(s) in " + state.totalFiles + " file(s)"
        : state.phase === "error" ? "Scan failed" : "Ready to scan";

    const banner = $("banner");
    if (state.phase === "error" && state.message) {
      banner.textContent = state.message;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }

    $("agent-count").textContent = state.agents.length ? state.agents.length + " active" : "";
    renderAgents(scanning);
    renderSeverity();
    renderFeed();

    $("cancel").classList.toggle("hidden", !scanning);
    $("report").disabled = !state.hasReport;
    $("report").classList.toggle("hidden", !state.hasReport && !scanning);
    $("error-count").textContent = state.errors > 0 ? state.errors + " error(s)" : "";
  }

  function renderAgents(scanning) {
    const host = $("agents");
    if (!state.agents.length) {
      host.innerHTML = '<div class="empty-hint">Agents appear when a scan starts.</div>';
      return;
    }
    host.innerHTML = state.agents.map((agent) => {
      const cls = agent.active ? "working" : (state.phase === "done" || !scanning ? "done" : "");
      return '<div class="agent ' + cls + '">'
        + '<span class="dot"></span>'
        + '<span class="agent-name" title="' + escapeHtml(agent.name) + '">' + escapeHtml(agent.name) + '</span>'
        + (agent.active
            ? '<span class="agent-active" title="' + escapeHtml(agent.active) + '">' + escapeHtml(agent.active) + '</span>'
            : '<span class="agent-meta">' + agent.files + 'f · ' + agent.findings + 'i</span>')
        + '</div>';
    }).join("");
  }

  function renderSeverity() {
    const host = $("sev");
    host.innerHTML = SEVERITIES.map((severity) => {
      const count = state.severity[severity] || 0;
      const active = state.filter === severity;
      return '<button data-filter="' + severity + '" class="' + (active ? "active" : "") + '" title="Filter findings tree by ' + severity + '">'
        + '<span class="swatch" style="background:' + SEV_COLORS[severity] + '"></span>'
        + severity + '<span class="count">' + count + '</span></button>';
    }).join("") + '<button data-filter="all" class="' + (state.filter === "all" ? "active" : "") + '">all<span class="count">' + state.findings + '</span></button>';
  }

  function renderFeed() {
    const host = $("feed");
    $("feed-count").textContent = state.feed.length ? state.feed.length + " event(s)" : "";
    host.innerHTML = state.feed.map((item) => {
      const sevColor = item.severity ? SEV_COLORS[item.severity] || "" : "";
      const icon = item.kind === "finding" && item.severity
        ? '<span style="color:' + sevColor + '">' + ICONS.finding + '</span>'
        : ICONS[item.kind] || ICONS.info;
      const offset = state.startedAt ? fmtTime(item.at - state.startedAt) : "";
      const clickable = item.file ? ' data-file="' + escapeHtml(item.file) + '" data-line="' + (item.line || 1) + '"' : "";
      return '<li class="feed-item ' + item.kind + '"' + clickable + '>'
        + '<span class="ico">' + icon + '</span>'
        + '<span class="body"><span class="txt">' + escapeHtml(item.text) + '</span>'
        + (item.detail ? '<span class="det">' + escapeHtml(item.detail) + '</span>' : "")
        + '</span>'
        + '<span class="time">' + offset + '</span>'
        + '</li>';
    }).join("");
  }

  function tick() {
    if (!state) return;
    $("stat-time").textContent = fmtTime(elapsed());
    if (state.phase === "scanning") {
      $("progress-text").textContent = state.totalFiles > 0
        ? "Scanning " + state.doneFiles + " of " + state.totalFiles + " files"
        : "Discovering files…";
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message && message.type === "state") {
      state = message.state;
      render();
    }
  });

  document.addEventListener("click", (event) => {
    const filter = event.target.closest("[data-filter]");
    if (filter) {
      vscode.postMessage({ type: "filter", value: filter.getAttribute("data-filter") });
      return;
    }
    const item = event.target.closest(".feed-item[data-file]");
    if (item) {
      vscode.postMessage({
        type: "open",
        file: item.getAttribute("data-file"),
        line: Number(item.getAttribute("data-line")) || 1,
      });
      return;
    }
    const button = event.target.closest("[data-command]");
    if (button) {
      vscode.postMessage({ type: "command", command: button.getAttribute("data-command") });
    }
  });

  if (ticker) clearInterval(ticker);
  ticker = setInterval(tick, 1000);
</script>
</body>
</html>`;
  }
}
