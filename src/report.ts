import * as vscode from "vscode";

import type { Finding, ScanRecord, Severity } from "./types";
import { normalizeSeverity, resolveFindingUri, severityRank } from "./util";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

interface ReportData {
  target: string;
  root: string;
  scannedAt: number;
  durationMs: number | null;
  filesScanned: number;
  agents: string[];
  findings: Finding[];
  errors: string[];
  counts: Record<Severity, number>;
  categories: Array<{ name: string; count: number }>;
  files: Array<{ name: string; count: number }>;
}

function buildData(record: ScanRecord): ReportData {
  const counts: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  const categories = new Map<string, number>();
  const files = new Map<string, number>();

  for (const finding of record.findings) {
    counts[normalizeSeverity(finding.severity)] += 1;
    const category = (finding.category || "uncategorized").trim() || "uncategorized";
    categories.set(category, (categories.get(category) ?? 0) + 1);
    const file = finding.file || "(unknown)";
    files.set(file, (files.get(file) ?? 0) + 1);
  }

  const agents = new Set<string>(record.agents ?? []);
  for (const finding of record.findings) {
    for (const agent of (finding.agent ?? "").split(",")) {
      const name = agent.trim();
      if (name) {
        agents.add(name);
      }
    }
  }

  return {
    target: record.target,
    root: record.root,
    scannedAt: record.scannedAt,
    durationMs: record.durationMs ?? null,
    filesScanned: record.files_scanned,
    agents: [...agents],
    findings: [...record.findings].sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        a.file.localeCompare(b.file) ||
        (a.line ?? 0) - (b.line ?? 0),
    ),
    errors: record.errors,
    counts,
    categories: [...categories.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    files: [...files.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

export class ReportPanel {
  private static current: ReportPanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private record: ScanRecord,
  ) {
    panel.onDidDispose(() => {
      if (ReportPanel.current === this) {
        ReportPanel.current = undefined;
      }
    });
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    this.render();
  }

  static show(record: ScanRecord): void {
    if (ReportPanel.current) {
      const existing = ReportPanel.current;
      existing.record = record;
      existing.render();
      existing.panel.reveal(undefined, true);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "cyclon.report",
      "Cyclon Report",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ReportPanel.current = new ReportPanel(panel, record);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const message = raw as {
      type?: string;
      file?: string;
      line?: number;
      text?: string;
      command?: string;
    };

    if (message.type === "open" && typeof message.file === "string") {
      const uri = resolveFindingUri(this.record.root, message.file);
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
      return;
    }

    if (message.type === "copy" && typeof message.text === "string") {
      await vscode.env.clipboard.writeText(message.text);
      void vscode.window.showInformationMessage("Cyclon: copied to the clipboard.");
      return;
    }

    if (message.type === "command" && typeof message.command === "string") {
      await vscode.commands.executeCommand(message.command);
    }
  }

  private render(): void {
    const data = buildData(this.record);
    const scriptNonce = nonce();
    const json = JSON.stringify(data).replace(/</g, "\\u003c");
    const title = this.record.target.split(/[\\/]/).filter(Boolean).pop() || "Report";
    this.panel.title = `Cyclon Report — ${title}`;

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #0f1117;
    --bg-2: #151821;
    --panel: #1a1e28;
    --panel-2: #202531;
    --line: rgba(255,255,255,.075);
    --line-strong: rgba(255,255,255,.13);
    --text: #e7e9ee;
    --muted: #8b93a7;
    --faint: #626a7d;
    --accent: #ff6c37;
    --accent-soft: rgba(255,108,55,.13);
    --critical: #f87171;
    --high: #fb923c;
    --medium: #fbbf24;
    --low: #60a5fa;
    --info: #94a3b8;
    --ok: #34d399;
    --radius: 10px;
    --mono: var(--vscode-editor-font-family, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: var(--vscode-font-family, -apple-system, "Segoe UI", system-ui, sans-serif);
    font-size: 13px; line-height: 1.5; overflow: hidden;
  }
  button { font-family: inherit; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 6px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-track { background: transparent; }

  .app { display: flex; flex-direction: column; height: 100vh; }

  /* ── top bar ─────────────────────────────────────────── */
  .topbar {
    display: flex; align-items: center; gap: 14px;
    height: 52px; flex: none; padding: 0 16px;
    background: var(--bg-2); border-bottom: 1px solid var(--line);
  }
  .logo {
    width: 28px; height: 28px; border-radius: 8px; flex: none;
    display: grid; place-items: center; font-size: 14px; color: #fff;
    background: linear-gradient(135deg, #ff8a5c, #ff5b22);
    box-shadow: 0 2px 10px rgba(255,108,55,.35);
  }
  .brand-name { font-weight: 700; letter-spacing: .2px; }
  .crumb { color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 7px; min-width: 0; }
  .crumb .sep { color: var(--faint); }
  .crumb .target { color: var(--text); font-family: var(--mono); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 42vw; }
  .top-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
  .status {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: var(--ok); background: rgba(52,211,153,.1);
    border: 1px solid rgba(52,211,153,.3); border-radius: 999px; padding: 4px 9px;
  }
  .status .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--line-strong); background: var(--panel-2); color: var(--text);
    border-radius: 6px; padding: 6px 11px; font-size: 11.5px; font-weight: 600; cursor: pointer;
  }
  .btn:hover { background: #2a3040; }
  .btn.primary { background: var(--accent); border-color: transparent; color: #fff; }
  .btn.primary:hover { background: #ff7d4d; }
  .btn.small { padding: 4px 8px; font-size: 10.5px; }

  /* ── layout ──────────────────────────────────────────── */
  .body { flex: 1; display: flex; min-height: 0; }

  /* ── sidebar ─────────────────────────────────────────── */
  .sidebar {
    width: 250px; flex: none; overflow-y: auto;
    background: var(--bg-2); border-right: 1px solid var(--line);
    padding: 12px 10px 24px;
  }
  .side-title {
    font-size: 9.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
    color: var(--faint); padding: 8px 8px 6px;
  }
  .nav { display: flex; flex-direction: column; gap: 1px; }
  .nav-item {
    display: flex; align-items: center; gap: 8px; width: 100%;
    border: none; background: transparent; color: var(--muted);
    text-align: left; padding: 6px 8px; border-radius: 6px;
    font-size: 12px; cursor: pointer;
  }
  .nav-item:hover { background: rgba(255,255,255,.05); color: var(--text); }
  .nav-item.active { background: var(--accent-soft); color: #ffb08f; }
  .nav-item .ico { width: 14px; text-align: center; flex: none; font-size: 11px; }
  .nav-item .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nav-item .n {
    font-size: 10px; font-variant-numeric: tabular-nums; color: var(--faint);
    background: rgba(255,255,255,.06); border-radius: 999px; padding: 0 6px; flex: none;
  }
  .nav-item.active .n { color: #ffb08f; background: rgba(255,108,55,.18); }
  .nav-item .swatch { width: 7px; height: 7px; border-radius: 50%; flex: none; margin: 0 3px; }
  .divider { height: 1px; background: var(--line); margin: 8px 6px; }

  /* ── main ────────────────────────────────────────────── */
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .tabs {
    display: flex; gap: 2px; align-items: center; flex: none;
    padding: 0 18px; height: 44px; border-bottom: 1px solid var(--line); background: var(--bg-2);
  }
  .tab {
    position: relative; border: none; background: transparent; color: var(--muted);
    font-size: 12px; font-weight: 600; padding: 0 12px; height: 44px; cursor: pointer;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--text); }
  .tab.active::after {
    content: ""; position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px;
    background: var(--accent); border-radius: 2px 2px 0 0;
  }
  .tab .badge {
    display: inline-block; margin-left: 6px; font-size: 10px; color: var(--faint);
    background: rgba(255,255,255,.07); border-radius: 999px; padding: 0 6px;
  }
  .content { flex: 1; overflow-y: auto; padding: 20px 22px 60px; }

  /* ── overview ────────────────────────────────────────── */
  .hero { display: flex; align-items: flex-start; gap: 22px; flex-wrap: wrap; margin-bottom: 22px; }
  .hero-copy { flex: 1; min-width: 220px; }
  .hero-title { font-size: 20px; font-weight: 700; letter-spacing: -.3px; margin: 0 0 4px; }
  .hero-sub { color: var(--muted); font-size: 12px; }
  .hero-sub code { font-family: var(--mono); font-size: 11px; color: #b9c0d0; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; margin-bottom: 22px; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 13px 14px;
  }
  .card .k { font-size: 9.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--faint); font-weight: 700; }
  .card .v { font-size: 24px; font-weight: 700; letter-spacing: -.5px; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .card .s { font-size: 10.5px; color: var(--muted); }
  .card.accent .v { color: var(--accent); }
  .card.ok .v { color: var(--ok); }

  .grid2 { display: grid; grid-template-columns: 1.1fr .9fr; gap: 14px; align-items: start; }
  @media (max-width: 820px) { .grid2 { grid-template-columns: 1fr; } }
  .box {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 16px;
  }
  .box h3 {
    margin: 0 0 14px; font-size: 10px; letter-spacing: .1em;
    text-transform: uppercase; color: var(--faint); font-weight: 700;
  }
  .donut-row { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .donut {
    --size: 132px;
    width: var(--size); height: var(--size); border-radius: 50%; flex: none;
    display: grid; place-items: center; position: relative;
  }
  .donut::after {
    content: ""; position: absolute; inset: 16px; border-radius: 50%; background: var(--panel);
  }
  .donut-center { position: relative; z-index: 1; text-align: center; }
  .donut-center .n { font-size: 26px; font-weight: 700; line-height: 1; }
  .donut-center .l { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); margin-top: 3px; }
  .legend { flex: 1; min-width: 140px; display: flex; flex-direction: column; gap: 7px; }
  .legend-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
  .legend-row .sw { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  .legend-row .nm { flex: 1; color: var(--muted); text-transform: capitalize; }
  .legend-row .ct { font-variant-numeric: tabular-nums; font-weight: 600; }
  .legend-row .pct { color: var(--faint); width: 40px; text-align: right; font-variant-numeric: tabular-nums; }

  .bars { display: flex; flex-direction: column; gap: 9px; }
  .bar-row .bar-head { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; margin-bottom: 3px; }
  .bar-row .bar-head .nm { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-row .bar-head .ct { font-variant-numeric: tabular-nums; }
  .bar-track { height: 5px; background: rgba(255,255,255,.07); border-radius: 999px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), #ff9d73); }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px;
    color: var(--muted); background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 999px; padding: 3px 9px;
  }
  .chip b { color: var(--text); font-weight: 600; }

  .errors-list { display: flex; flex-direction: column; gap: 6px; }
  .error-item {
    font-family: var(--mono); font-size: 10.5px; color: #fca5a5;
    background: rgba(248,113,113,.07); border: 1px solid rgba(248,113,113,.18);
    border-radius: 6px; padding: 7px 9px; word-break: break-word;
  }

  /* ── findings ────────────────────────────────────────── */
  .toolbar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px;
  }
  .search {
    flex: 1; min-width: 180px; display: flex; align-items: center; gap: 8px;
    background: var(--panel); border: 1px solid var(--line-strong);
    border-radius: 7px; padding: 7px 10px;
  }
  .search input {
    flex: 1; min-width: 0; background: transparent; border: none; outline: none;
    color: var(--text); font-family: inherit; font-size: 12px;
  }
  .search input::placeholder { color: var(--faint); }
  select.sort {
    background: var(--panel); border: 1px solid var(--line-strong); color: var(--text);
    border-radius: 7px; padding: 7px 9px; font-family: inherit; font-size: 11.5px; outline: none;
  }
  .filter-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 14px; }
  .fpill {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10.5px; font-weight: 600; color: var(--muted);
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 999px; padding: 3px 9px; cursor: pointer;
  }
  .fpill:hover { color: var(--text); }
  .fpill.active { color: #fff; border-color: var(--accent); background: var(--accent-soft); }
  .fpill .sw { width: 6px; height: 6px; border-radius: 50%; }

  .finding-list { display: flex; flex-direction: column; gap: 9px; }
  .finding {
    position: relative; background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 12px 14px 12px 18px; overflow: hidden;
  }
  .finding::before {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    background: var(--sev, var(--info));
  }
  .finding-head { display: flex; align-items: flex-start; gap: 9px; }
  .sev-badge {
    flex: none; font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
    color: #0f1117; background: var(--sev, var(--info)); border-radius: 4px; padding: 2px 6px; margin-top: 1px;
  }
  .finding-title { flex: 1; min-width: 0; font-size: 13.5px; font-weight: 650; line-height: 1.35; }
  .finding-loc {
    font-family: var(--mono); font-size: 10.5px; color: #9fb3d1;
    background: rgba(96,165,250,.08); border-radius: 4px; padding: 1px 6px;
    cursor: pointer; white-space: nowrap;
  }
  .finding-loc:hover { background: rgba(96,165,250,.16); }
  .finding-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 7px 0 0; }
  .tag {
    font-size: 9.5px; color: var(--muted); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px;
  }
  .finding-desc { color: #b9c0d0; font-size: 12px; margin-top: 9px; white-space: pre-wrap; }
  .suggestion {
    margin-top: 10px; border: 1px solid var(--line); border-radius: 7px; overflow: hidden;
  }
  .suggestion-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    background: var(--panel-2); padding: 5px 9px; font-size: 9.5px;
    letter-spacing: .07em; text-transform: uppercase; color: var(--faint); font-weight: 700;
  }
  .suggestion pre {
    margin: 0; padding: 9px 11px; background: #0c0f15; color: #d6e2f0;
    font-family: var(--mono); font-size: 11px; line-height: 1.5;
    overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  }
  .finding-actions { display: flex; gap: 6px; margin-top: 10px; }

  .empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 6px; padding: 56px 20px; color: var(--muted); text-align: center;
  }
  .empty .big { font-size: 30px; opacity: .5; }
  .empty .t { font-size: 14px; font-weight: 600; color: var(--text); }
  .empty .s { font-size: 11.5px; }

  /* ── raw ─────────────────────────────────────────────── */
  .raw-wrap { position: relative; }
  .raw-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  pre.raw {
    margin: 0; background: #0c0f15; border: 1px solid var(--line); border-radius: var(--radius);
    padding: 14px; font-family: var(--mono); font-size: 11px; line-height: 1.55;
    color: #cfd8e6; overflow: auto; max-height: calc(100vh - 190px);
  }
  .hidden { display: none !important; }
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="logo">◈</div>
    <div class="brand-name">Cyclon</div>
    <div class="crumb">
      <span class="sep">/</span><span>Reports</span>
      <span class="sep">/</span><span class="target" id="crumb-target"></span>
    </div>
    <div class="top-actions">
      <span class="status"><span class="dot"></span>Complete</span>
      <button class="btn small" id="copy-summary">Copy summary</button>
      <button class="btn small primary" data-command="cyclon.scanWorkspace">Rescan</button>
    </div>
  </div>

  <div class="body">
    <aside class="sidebar" id="sidebar"></aside>
    <div class="main">
      <div class="tabs" id="tabs">
        <button class="tab" data-tab="overview">Overview</button>
        <button class="tab" data-tab="findings">Findings<span class="badge" id="tab-findings-count"></span></button>
        <button class="tab" data-tab="raw">Raw JSON</button>
      </div>
      <div class="content" id="content"></div>
    </div>
  </div>
</div>

<script nonce="${scriptNonce}">
  const DATA = ${json};
  const SEVERITIES = ["critical", "high", "medium", "low", "info"];
  const SEV_COLORS = {
    critical: "#f87171", high: "#fb923c", medium: "#fbbf24",
    low: "#60a5fa", info: "#94a3b8",
  };
  const ICONS = { overview: "◫", all: "◈", errors: "⚠", file: "▤", category: "◧" };
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const view = {
    tab: "overview",
    nav: "overview",
    query: "",
    sort: "severity",
    severity: "all",
  };

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function pct(part, total) {
    return total > 0 ? Math.round((part / total) * 100) : 0;
  }

  function duration() {
    if (!DATA.durationMs) return "—";
    const s = DATA.durationMs / 1000;
    return s < 60 ? s.toFixed(1) + "s" : Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  }

  function when() {
    try { return new Date(DATA.scannedAt).toLocaleString(); } catch { return ""; }
  }

  function filteredFindings() {
    let list = DATA.findings;
    if (view.severity !== "all") {
      list = list.filter((f) => (f.severity || "info").toLowerCase() === view.severity);
    }
    if (view.nav.startsWith("file:")) {
      const file = view.nav.slice(5);
      list = list.filter((f) => (f.file || "(unknown)") === file);
    } else if (view.nav.startsWith("category:")) {
      const category = view.nav.slice(9);
      list = list.filter((f) => ((f.category || "uncategorized").trim() || "uncategorized") === category);
    }
    if (view.query) {
      const q = view.query.toLowerCase();
      list = list.filter((f) =>
        [f.title, f.description, f.file, f.category, f.agent]
          .filter(Boolean).join(" ").toLowerCase().includes(q),
      );
    }
    const rank = (s) => SEVERITIES.indexOf((s || "info").toLowerCase());
    return [...list].sort((a, b) => {
      if (view.sort === "file") return (a.file || "").localeCompare(b.file || "") || (a.line || 0) - (b.line || 0);
      if (view.sort === "category") return (a.category || "").localeCompare(b.category || "");
      return rank(a.severity) - rank(b.severity) || (a.file || "").localeCompare(b.file || "");
    });
  }

  function renderSidebar() {
    const items = [];
    items.push(navItem("overview", ICONS.overview, "Overview", DATA.findings.length, "overview"));
    items.push(navItem("all", ICONS.all, "All findings", DATA.findings.length, "findings"));
    items.push('<div class="divider"></div>');
    items.push('<div class="side-title">By severity</div>');
    for (const severity of SEVERITIES) {
      items.push(navItem("sev:" + severity, "", severity, DATA.counts[severity], "findings", severity));
    }
    if (DATA.categories.length) {
      items.push('<div class="divider"></div>');
      items.push('<div class="side-title">By category</div>');
      for (const category of DATA.categories.slice(0, 12)) {
        items.push(navItem("category:" + category.name, ICONS.category, category.name, category.count, "findings"));
      }
    }
    if (DATA.files.length) {
      items.push('<div class="divider"></div>');
      items.push('<div class="side-title">By file</div>');
      for (const file of DATA.files.slice(0, 30)) {
        const short = file.name.split("/").pop() || file.name;
        items.push(navItem("file:" + file.name, ICONS.file, short, file.count, "findings", null, file.name));
      }
    }
    if (DATA.errors.length) {
      items.push('<div class="divider"></div>');
      items.push(navItem("errors", ICONS.errors, "Errors", DATA.errors.length, "overview"));
    }
    $("sidebar").innerHTML = items.join("");
  }

  function navItem(nav, icon, label, count, tab, severity, title) {
    let active = view.nav === nav;
    if (nav === "overview" && view.tab === "overview" && view.nav === "overview") active = true;
    const swatch = severity
      ? '<span class="swatch" style="background:' + SEV_COLORS[severity] + '"></span>'
      : '<span class="ico">' + (icon || "") + "</span>";
    return '<button class="nav-item ' + (active ? "active" : "") + '" data-nav="' + esc(nav) + '" data-tab-target="' + tab + '" title="' + esc(title || label) + '">'
      + swatch
      + '<span class="label" style="text-transform:' + (severity ? "capitalize" : "none") + '">' + esc(label) + '</span>'
      + '<span class="n">' + count + '</span>'
      + '</button>';
  }

  function renderTabs() {
    $("tab-findings-count").textContent = String(DATA.findings.length);
    for (const tab of document.querySelectorAll(".tab")) {
      tab.classList.toggle("active", tab.getAttribute("data-tab") === view.tab);
    }
  }

  function render() {
    renderSidebar();
    renderTabs();
    $("crumb-target").textContent = DATA.target || "workspace";
    $("crumb-target").title = DATA.target || "";
    if (view.tab === "overview") renderOverview();
    else if (view.tab === "findings") renderFindings();
    else renderRaw();
  }

  function renderOverview() {
    const total = DATA.findings.length;
    const donut = buildDonut();
    const severityRows = SEVERITIES.map((severity) => {
      const count = DATA.counts[severity] || 0;
      return '<div class="legend-row">'
        + '<span class="sw" style="background:' + SEV_COLORS[severity] + '"></span>'
        + '<span class="nm">' + severity + '</span>'
        + '<span class="ct">' + count + '</span>'
        + '<span class="pct">' + pct(count, total) + '%</span>'
        + '</div>';
    }).join("");

    const maxCategory = Math.max(1, ...DATA.categories.map((c) => c.count));
    const categoryRows = DATA.categories.slice(0, 8).map((category) =>
      '<div class="bar-row">'
      + '<div class="bar-head"><span class="nm">' + esc(category.name) + '</span><span class="ct">' + category.count + '</span></div>'
      + '<div class="bar-track"><div class="bar-fill" style="width:' + Math.round((category.count / maxCategory) * 100) + '%"></div></div>'
      + '</div>',
    ).join("") || '<div class="empty"><div class="s">No categories yet.</div></div>';

    const agentChips = DATA.agents.length
      ? DATA.agents.map((agent) => '<span class="chip">' + esc(agent) + '</span>').join("")
      : '<span class="chip">No agent metadata</span>';

    const errors = DATA.errors.length
      ? '<div class="box" style="margin-top:14px"><h3>Errors (' + DATA.errors.length + ')</h3><div class="errors-list">'
          + DATA.errors.map((error) => '<div class="error-item">' + esc(error) + '</div>').join("")
          + '</div></div>'
      : "";

    $("content").innerHTML = ''
      + '<div class="hero">'
      +   '<div class="hero-copy">'
      +     '<h1 class="hero-title">Scan report</h1>'
      +     '<div class="hero-sub">Generated <b>' + esc(when()) + '</b> · <code>' + esc(DATA.root || DATA.target) + '</code></div>'
      +   '</div>'
      + '</div>'
      + '<div class="cards">'
      +   card("Findings", total, "across " + DATA.filesScanned + " file(s)", total ? "accent" : "ok")
      +   card("Critical", DATA.counts.critical, "needs attention", DATA.counts.critical ? "accent" : "")
      +   card("Files scanned", DATA.filesScanned, "source files", "")
      +   card("Duration", duration(), "wall clock", "")
      + '</div>'
      + '<div class="grid2">'
      +   '<div class="box"><h3>Severity breakdown</h3><div class="donut-row">'
      +     '<div class="donut" style="background:' + donut + '"><div class="donut-center"><div class="n">' + total + '</div><div class="l">findings</div></div></div>'
      +     '<div class="legend">' + severityRows + '</div>'
      +   '</div></div>'
      +   '<div class="box"><h3>Top categories</h3><div class="bars">' + categoryRows + '</div></div>'
      + '</div>'
      + '<div class="box" style="margin-top:14px"><h3>Agents</h3><div class="chips">' + agentChips + '</div></div>'
      + errors;
  }

  function card(key, value, sub, cls) {
    return '<div class="card ' + cls + '"><div class="k">' + esc(key) + '</div>'
      + '<div class="v">' + esc(value) + '</div><div class="s">' + esc(sub) + '</div></div>';
  }

  function buildDonut() {
    const total = DATA.findings.length;
    if (!total) return "conic-gradient(rgba(255,255,255,.08) 0 100%)";
    let start = 0;
    const stops = [];
    for (const severity of SEVERITIES) {
      const count = DATA.counts[severity] || 0;
      if (!count) continue;
      const end = start + (count / total) * 100;
      stops.push(SEV_COLORS[severity] + " " + start.toFixed(2) + "% " + end.toFixed(2) + "%");
      start = end;
    }
    return "conic-gradient(" + stops.join(", ") + ")";
  }

  function renderFindings() {
    const list = filteredFindings();
    const pills = ['<button class="fpill ' + (view.severity === "all" ? "active" : "") + '" data-sev="all">All<span>' + DATA.findings.length + '</span></button>'];
    for (const severity of SEVERITIES) {
      pills.push('<button class="fpill ' + (view.severity === severity ? "active" : "") + '" data-sev="' + severity + '">'
        + '<span class="sw" style="background:' + SEV_COLORS[severity] + '"></span>' + severity
        + '<span style="color:var(--faint)">' + (DATA.counts[severity] || 0) + '</span></button>');
    }

    const cards = list.map(findingCard).join("");

    $("content").innerHTML = ''
      + '<div class="toolbar">'
      +   '<div class="search"><span style="color:var(--faint)">⌕</span>'
      +     '<input id="q" placeholder="Search findings, files, categories, agents…" value="' + esc(view.query) + '">'
      +   '</div>'
      +   '<select class="sort" id="sort">'
      +     '<option value="severity"' + (view.sort === "severity" ? " selected" : "") + '>Sort: severity</option>'
      +     '<option value="file"' + (view.sort === "file" ? " selected" : "") + '>Sort: file</option>'
      +     '<option value="category"' + (view.sort === "category" ? " selected" : "") + '>Sort: category</option>'
      +   '</select>'
      + '</div>'
      + '<div class="filter-pills">' + pills.join("") + '</div>'
      + (list.length
          ? '<div class="finding-list">' + cards + '</div>'
          : '<div class="empty"><div class="big">✓</div><div class="t">No findings match</div><div class="s">Try clearing the search or severity filter.</div></div>');

    const input = $("q");
    if (input) {
      input.addEventListener("input", (event) => {
        view.query = event.target.value;
        const at = event.target.selectionStart;
        renderFindings();
        const next = $("q");
        if (next) { next.focus(); try { next.setSelectionRange(at, at); } catch {} }
      });
    }
    const sort = $("sort");
    if (sort) {
      sort.addEventListener("change", (event) => {
        view.sort = event.target.value;
        renderFindings();
      });
    }
  }

  function findingCard(finding, index) {
    const severity = (finding.severity || "info").toLowerCase();
    const color = SEV_COLORS[severity] || SEV_COLORS.info;
    const loc = finding.file + (finding.line ? ":" + finding.line : "");
    const id = "f" + index;
    return '<div class="finding" style="--sev:' + color + '">'
      + '<div class="finding-head">'
      +   '<span class="sev-badge">' + esc(severity) + '</span>'
      +   '<span class="finding-title">' + esc(finding.title || "Issue") + '</span>'
      +   '<span class="finding-loc" data-open="' + esc(finding.file) + '" data-line="' + (finding.line || 1) + '" title="Open in editor">' + esc(loc) + '</span>'
      + '</div>'
      + '<div class="finding-meta">'
      +   (finding.category ? '<span class="tag">' + esc(finding.category) + '</span>' : "")
      +   (finding.agent ? '<span class="tag">agent: ' + esc(finding.agent) + '</span>' : "")
      + '</div>'
      + (finding.description ? '<div class="finding-desc">' + esc(finding.description) + '</div>' : "")
      + (finding.suggestion
          ? '<div class="suggestion"><div class="suggestion-head"><span>Suggested fix</span>'
              + '<button class="btn small" data-copy="' + id + '">Copy</button></div>'
              + '<pre id="' + id + '">' + esc(finding.suggestion) + '</pre></div>'
          : "")
      + '<div class="finding-actions">'
      +   '<button class="btn small" data-open="' + esc(finding.file) + '" data-line="' + (finding.line || 1) + '">Open in editor</button>'
      +   (finding.suggestion ? '<button class="btn small" data-copy="' + id + '">Copy fix</button>' : "")
      + '</div>'
      + '</div>';
  }

  function renderRaw() {
    const payload = {
      root: DATA.root,
      files_scanned: DATA.filesScanned,
      agents: DATA.agents,
      duration_ms: DATA.durationMs,
      scanned_at: new Date(DATA.scannedAt).toISOString(),
      findings: DATA.findings,
      errors: DATA.errors,
    };
    const text = JSON.stringify(payload, null, 2);
    $("content").innerHTML = '<div class="raw-wrap">'
      + '<div class="raw-head"><span style="color:var(--muted);font-size:11.5px">cyclon scan --json</span>'
      + '<button class="btn small" data-copy-raw="1">Copy JSON</button></div>'
      + '<pre class="raw" id="raw">' + esc(text) + '</pre></div>';
  }

  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      view.nav = nav.getAttribute("data-nav");
      const target = nav.getAttribute("data-tab-target");
      if (target === "overview") { view.tab = "overview"; }
      else if (target === "findings") { view.tab = "findings"; }
      if (view.nav.startsWith("sev:")) view.severity = view.nav.slice(4);
      else if (view.nav === "all") view.severity = "all";
      if (view.nav === "errors") { view.tab = "overview"; }
      render();
      return;
    }
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      view.tab = tab.getAttribute("data-tab");
      if (view.tab === "overview") view.nav = "overview";
      render();
      return;
    }
    const sev = event.target.closest("[data-sev]");
    if (sev) {
      view.severity = sev.getAttribute("data-sev");
      view.nav = view.severity === "all" ? "all" : "sev:" + view.severity;
      renderFindings();
      renderSidebar();
      return;
    }
    const open = event.target.closest("[data-open]");
    if (open) {
      vscode.postMessage({ type: "open", file: open.getAttribute("data-open"), line: Number(open.getAttribute("data-line")) || 1 });
      return;
    }
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      const pre = document.getElementById(copy.getAttribute("data-copy"));
      if (pre) vscode.postMessage({ type: "copy", text: pre.textContent });
      return;
    }
    if (event.target.closest("[data-copy-raw]")) {
      vscode.postMessage({ type: "copy", text: $("raw").textContent });
      return;
    }
    const command = event.target.closest("[data-command]");
    if (command) {
      vscode.postMessage({ type: "command", command: command.getAttribute("data-command") });
      return;
    }
    if (event.target.closest("#copy-summary")) {
      const summary = "Cyclon scan of " + DATA.target + "\\n"
        + DATA.findings.length + " finding(s) in " + DATA.filesScanned + " file(s)\\n"
        + "Critical: " + DATA.counts.critical + " · High: " + DATA.counts.high
        + " · Medium: " + DATA.counts.medium + " · Low: " + DATA.counts.low
        + " · Info: " + DATA.counts.info;
      vscode.postMessage({ type: "copy", text: summary });
    }
  });

  render();
</script>
</body>
</html>`;
  }
}
