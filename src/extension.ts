import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { CyclonRunner, ScanCancelledError, prepareReportPath } from "./cyclon";
import { FindingsProvider, OverviewProvider } from "./findingsTree";
import { FindingDetailPanel, ReportPanel } from "./panels";
import { ScanStore, type FindingRef } from "./store";
import { SEVERITIES, type ScanRecord, type Severity, type SeverityFilter } from "./types";
import { severityRank, truncate } from "./util";

const SECRET_KEYS = "cyclon.apiKeys";
const CTX_SCANNING = "cyclon.scanning";

let activeRunner: CyclonRunner | undefined;

interface RunScanOptions {
  label?: string;
  merge?: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Cyclon");
  const diagnostics = vscode.languages.createDiagnosticCollection("cyclon");
  context.subscriptions.push(output, diagnostics);

  const store = new ScanStore(context.workspaceState, diagnostics);
  store.restore();

  const runner = new CyclonRunner();
  activeRunner = runner;

  const findingsProvider = new FindingsProvider(store);
  const overviewProvider = new OverviewProvider(store);
  const findingsView = vscode.window.createTreeView("cyclon.findings", {
    treeDataProvider: findingsProvider,
    showCollapseAll: true,
  });
  const overviewView = vscode.window.createTreeView("cyclon.overview", {
    treeDataProvider: overviewProvider,
  });
  context.subscriptions.push(findingsView, overviewView);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.name = "Cyclon";
  status.command = "cyclon.findings.focus";
  context.subscriptions.push(status);

  let activeCancellation: vscode.CancellationTokenSource | undefined;

  const updateStatus = (): void => {
    if (runner.running) {
      status.text = "$(sync~spin) Cyclon";
      status.tooltip = "Cyclon is scanning…";
      status.backgroundColor = undefined;
      return;
    }

    const record = store.record;
    if (!record) {
      status.text = "$(shield) Cyclon";
      status.tooltip = "Run a Cyclon scan";
      status.backgroundColor = undefined;
      return;
    }

    const total = record.findings.length;
    const worst = record.findings.reduce(
      (rank, finding) => Math.min(rank, severityRank(finding.severity)),
      9,
    );

    status.text = `$(shield) ${total}`;
    status.tooltip = `${total} issue(s) · ${record.files_scanned} file(s) scanned`;
    status.backgroundColor =
      worst <= 1
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : worst === 2
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
  };

  const setScanningContext = async (value: boolean): Promise<void> => {
    await vscode.commands.executeCommand("setContext", CTX_SCANNING, value);
  };

  const runScan = async (target: string, options: RunScanOptions = {}): Promise<void> => {
    if (runner.running) {
      void vscode.window.showWarningMessage("Cyclon is already scanning.");
      return;
    }

    const config = vscode.workspace.getConfiguration("cyclon");
    const storedKeys = (await context.secrets.get(SECRET_KEYS)) ?? "";
    if (!storedKeys && !hasConfiguredKeys()) {
      const choice = await vscode.window.showErrorMessage(
        "Cyclon: no xAI API key configured.",
        "Set API Keys",
      );
      if (choice) {
        await vscode.commands.executeCommand("cyclon.setApiKeys");
      }
      return;
    }

    const label = options.label ?? path.basename(target);
    const reportPath = prepareReportPath(context.globalStorageUri.fsPath);
    const env = buildEnvironment(storedKeys, config);

    output.show(true);
    output.appendLine("");
    output.appendLine(`▶ cyclon scan ${target}`);

    const cancellation = new vscode.CancellationTokenSource();
    activeCancellation = cancellation;
    await setScanningContext(true);
    updateStatus();

    let record: ScanRecord | undefined;

    try {
      record = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cyclon: scanning ${label}`,
          cancellable: true,
        },
        async (progress, token) => {
          const inner = token.onCancellationRequested(() => {
            cancellation.cancel();
            runner.cancel();
          });
          try {
            return await runner.run(
              { target, htmlPath: reportPath, env },
              cancellation.token,
              (line) => {
                output.appendLine(line);
                const message = line.replace(/^Scanning\s+/i, "");
                progress.report({ message: truncate(message, 80) });
              },
            );
          } finally {
            inner.dispose();
          }
        },
      );
    } catch (error) {
      if (error instanceof ScanCancelledError) {
        output.appendLine("Scan cancelled.");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`ERROR: ${message}`);
        const firstLine = message.split(/\r?\n/)[0];
        const choice = await vscode.window.showErrorMessage(
          `Cyclon: ${truncate(firstLine, 160)}`,
          "Show Log",
          "Set API Keys",
        );
        if (choice === "Show Log") {
          output.show();
        } else if (choice === "Set API Keys") {
          await vscode.commands.executeCommand("cyclon.setApiKeys");
        }
      }
      return;
    } finally {
      activeCancellation = undefined;
      cancellation.dispose();
      await setScanningContext(false);
      updateStatus();
    }

    if (!record) {
      return;
    }

    if (options.merge) {
      store.mergeFileScan(record);
    } else {
      store.setRecord(record);
    }

    const issueCount = record.findings.length;
    const parts = [`Cyclon: ${issueCount} issue(s) in ${record.files_scanned} file(s)`];
    if (record.errors.length > 0) {
      parts.push(`${record.errors.length} error(s) — see the Overview view`);
    }
    const actions = ["Show Problems"];
    if (fs.existsSync(record.reportPath)) {
      actions.push("Open Report");
    }
    const choice = await vscode.window.showInformationMessage(parts.join(" · "), ...actions);
    if (choice === "Show Problems") {
      await vscode.commands.executeCommand("workbench.actions.view.problems");
    } else if (choice === "Open Report") {
      ReportPanel.show(record);
    }

    if (config.get<boolean>("openReportAfterScan", false)) {
      ReportPanel.show(record);
    }
  };

  const register = (id: string, callback: (...args: any[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, callback));
  };

  register("cyclon.scanWorkspace", async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      void vscode.window.showWarningMessage("Cyclon: open a folder first.");
      return;
    }

    let folder = folders[0];
    if (folders.length > 1) {
      const picked = await vscode.window.showQuickPick(
        folders.map((item) => ({
          label: item.name,
          description: item.uri.fsPath,
          folder: item,
        })),
        { placeHolder: "Folder to scan" },
      );
      if (!picked) {
        return;
      }
      folder = picked.folder;
    }

    await runScan(folder.uri.fsPath, { label: folder.name });
  });

  register("cyclon.scanFile", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      void vscode.window.showWarningMessage("Cyclon: open a file to scan.");
      return;
    }

    const document = editor.document;
    if (document.isDirty) {
      const choice = await vscode.window.showWarningMessage(
        "Cyclon scans the file on disk. Save it before scanning?",
        { modal: true },
        "Save & Scan",
      );
      if (choice !== "Save & Scan") {
        return;
      }
      if (!(await document.save())) {
        return;
      }
    }

    await runScan(document.uri.fsPath, {
      label: path.basename(document.uri.fsPath),
      merge: true,
    });
  });

  register("cyclon.scanPath", async (uri?: vscode.Uri) => {
    if (!uri) {
      await vscode.commands.executeCommand("cyclon.scanWorkspace");
      return;
    }

    let isDirectory = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      void vscode.window.showWarningMessage(`Cyclon: cannot access ${uri.fsPath}.`);
      return;
    }

    await runScan(uri.fsPath, {
      label: path.basename(uri.fsPath),
      merge: !isDirectory,
    });
  });

  register("cyclon.cancelScan", () => {
    activeCancellation?.cancel();
    runner.cancel();
  });

  register("cyclon.clearFindings", () => {
    store.clear();
    void vscode.window.showInformationMessage("Cyclon: findings cleared.");
  });

  register("cyclon.filterSeverity", async (value?: SeverityFilter) => {
    let filter = value;
    if (!filter) {
      const record = store.record;
      const counts = new Map<Severity, number>();
      for (const finding of record?.findings ?? []) {
        const severity = finding.severity.toLowerCase() as Severity;
        if (SEVERITIES.includes(severity)) {
          counts.set(severity, (counts.get(severity) ?? 0) + 1);
        }
      }
      const items: Array<{ label: string; description: string; value: SeverityFilter }> = [
        {
          label: "All findings",
          description: `${record?.findings.length ?? 0}`,
          value: "all",
        },
        ...SEVERITIES.map((severity) => ({
          label: severity.charAt(0).toUpperCase() + severity.slice(1),
          description: `${counts.get(severity) ?? 0}`,
          value: severity as SeverityFilter,
        })),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Filter findings by severity",
      });
      if (!picked) {
        return;
      }
      filter = picked.value;
    }
    store.setFilter(filter);
  });

  register("cyclon.showReport", () => {
    const record = store.record;
    if (!record) {
      void vscode.window.showInformationMessage("Cyclon: run a scan first.");
      return;
    }
    ReportPanel.show(record);
  });

  register("cyclon.setApiKeys", async () => {
    const value = await vscode.window.showInputBox({
      title: "Cyclon API Keys",
      prompt:
        "Paste one or more xAI API keys separated by commas (one key per agent). Stored in VS Code SecretStorage.",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "xai-…, xai-…",
      validateInput: (input) =>
        input.trim().length > 0 ? undefined : "Enter at least one key, or press Escape to cancel.",
    });
    if (value === undefined) {
      return;
    }

    const keys = value
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean);
    if (keys.length === 0) {
      return;
    }

    await context.secrets.store(SECRET_KEYS, keys.join(","));
    const choice = await vscode.window.showInformationMessage(
      `Cyclon: stored ${keys.length} API key(s).`,
      "Scan Workspace",
    );
    if (choice) {
      await vscode.commands.executeCommand("cyclon.scanWorkspace");
    }
  });

  register("cyclon.clearApiKeys", async () => {
    const choice = await vscode.window.showWarningMessage(
      "Remove the API keys stored by Cyclon from VS Code SecretStorage?",
      { modal: true },
      "Remove",
    );
    if (choice !== "Remove") {
      return;
    }
    await context.secrets.delete(SECRET_KEYS);
    void vscode.window.showInformationMessage("Cyclon: stored API keys removed.");
  });

  register("cyclon.showOutput", () => output.show());

  register("cyclon.openFinding", async (ref?: FindingRef) => {
    if (!ref) {
      return;
    }
    const line = Math.max(0, (Number(ref.finding.line) || 1) - 1);
    const range = new vscode.Range(line, 0, line, 0);
    const document = await vscode.workspace.openTextDocument(ref.uri);
    const editor = await vscode.window.showTextDocument(document, {
      preview: true,
      selection: range,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });

  register("cyclon.showFindingDetails", (ref?: FindingRef) => {
    if (ref) {
      FindingDetailPanel.show(ref);
    }
  });

  register("cyclon.copySuggestion", async (ref?: FindingRef) => {
    const suggestion = ref?.finding.suggestion;
    if (!suggestion) {
      void vscode.window.showInformationMessage("Cyclon: this finding has no suggested fix.");
      return;
    }
    await vscode.env.clipboard.writeText(suggestion);
    void vscode.window.showInformationMessage("Cyclon: suggested fix copied to the clipboard.");
  });

  register("cyclon.refresh", () => {
    store.republish();
  });

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      {
        provideCodeActions(document, _range, codeActionContext) {
          const actions: vscode.CodeAction[] = [];
          for (const diagnostic of codeActionContext.diagnostics) {
            if (diagnostic.source !== "cyclon") {
              continue;
            }
            const ref = store.findingFor(diagnostic, document.uri);
            if (!ref) {
              continue;
            }

            const details = new vscode.CodeAction(
              "Cyclon: Show details",
              vscode.CodeActionKind.QuickFix,
            );
            details.command = {
              command: "cyclon.showFindingDetails",
              title: "Show details",
              arguments: [ref],
            };
            details.diagnostics = [diagnostic];
            actions.push(details);

            if (ref.finding.suggestion) {
              const copy = new vscode.CodeAction(
                "Cyclon: Copy suggested fix",
                vscode.CodeActionKind.QuickFix,
              );
              copy.command = {
                command: "cyclon.copySuggestion",
                title: "Copy suggested fix",
                arguments: [ref],
              };
              copy.diagnostics = [diagnostic];
              actions.push(copy);
            }
          }
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("cyclon.severityThreshold")) {
        store.republish();
      }
    }),
  );

  let saveTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") {
        return;
      }
      if (!vscode.workspace.getConfiguration("cyclon").get<boolean>("scanOnSave", false)) {
        return;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => {
        if (!runner.running) {
          void runScan(document.uri.fsPath, {
            label: path.basename(document.uri.fsPath),
            merge: true,
          });
        }
      }, 1200);
    }),
  );

  context.subscriptions.push(store.onDidChange(() => updateStatus()));

  updateStatus();
  status.show();
}

export function deactivate(): void {
  activeRunner?.cancel();
  activeRunner = undefined;
}

function hasConfiguredKeys(): boolean {
  if (
    process.env.XAI_API_KEY ||
    process.env.XAI_API_KEYS ||
    process.env.GROK_API_KEY ||
    process.env.GROK_API_KEYS
  ) {
    return true;
  }

  // The cyclon CLI also reads ~/.config/cyclon/config.json. Honor keys that
  // were configured with `cyclon config set-key` or by editing that file.
  try {
    const configPath = path.join(os.homedir(), ".config", "cyclon", "config.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      api_key?: unknown;
      api_keys?: unknown;
    };
    if (typeof parsed.api_key === "string" && parsed.api_key.trim()) {
      return true;
    }
    if (
      Array.isArray(parsed.api_keys) &&
      parsed.api_keys.some((key) => typeof key === "string" && key.trim())
    ) {
      return true;
    }
  } catch {
    // Missing or malformed config: fall through to "not configured".
  }

  return false;
}

function buildEnvironment(
  storedKeys: string,
  config: vscode.WorkspaceConfiguration,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (storedKeys) {
    env.XAI_API_KEYS = storedKeys;
  }
  const baseUrl = (config.get<string>("baseUrl", "") || "").trim();
  if (baseUrl) {
    env.XAI_BASE_URL = baseUrl;
  }
  return env;
}
