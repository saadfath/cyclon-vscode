/**
 * Self-contained smoke test.
 *
 * Mocks the VS Code API, starts a fake xAI endpoint, then runs the bundled
 * extension end-to-end against a temporary workspace. Requires the `cyclon`
 * CLI to be installed (the extension spawns it).
 *
 * Usage: npm test
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const FINDING = {
  file: "test.py",
  line: 2,
  severity: "high",
  category: "division-by-zero",
  title: "Division by zero",
  description: "b is not validated before division.",
  suggestion: "if b == 0: raise ValueError('b must not be zero')",
};

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {}
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}
class Diagnostic {
  constructor(range, message, severity) {
    Object.assign(this, { range, message, severity });
  }
}
class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}
class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.scheme = "file";
    this.path = fsPath;
  }
  static file(p) {
    return new Uri(p);
  }
  static joinPath(base, ...parts) {
    return new Uri(path.join(base.fsPath, ...parts));
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

const noopDisposable = { dispose: () => {} };

class CancellationTokenSource {
  constructor() {
    this.listeners = [];
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener) => {
        this.listeners.push(listener);
        return noopDisposable;
      },
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    for (const listener of this.listeners) listener();
  }
  dispose() {}
}

function createVscodeMock(workspaceDir) {
  const commands = new Map();
  const diagnosticsByFile = new Map();
  const storage = {};

  const vscode = {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    Range,
    Diagnostic,
    CodeAction,
    Uri,
    CancellationTokenSource,
    StatusBarAlignment: { Left: 1, Right: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    ViewColumn: { Active: -1, Beside: -2 },
    FileType: { File: 1, Directory: 2 },
    CodeActionKind: { QuickFix: "quickfix" },
    ProgressLocation: { Notification: 15 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createTreeView: () => noopDisposable,
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      withProgress: async (_options, task) =>
        task(
          { report() {} },
          { isCancellationRequested: false, onCancellationRequested: () => noopDisposable },
        ),
      createWebviewPanel: () => ({
        webview: { html: "", onDidReceiveMessage: () => noopDisposable },
        onDidDispose: () => noopDisposable,
        reveal() {},
        dispose() {},
      }),
    },
    workspace: {
      workspaceFolders: [{ name: "smoke", uri: Uri.file(workspaceDir) }],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeConfiguration: () => noopDisposable,
      onDidSaveTextDocument: () => noopDisposable,
      asRelativePath: (uri) => uri.fsPath,
      openTextDocument: async () => ({}),
      fs: { stat: async () => ({ type: 1 }) },
    },
    languages: {
      createDiagnosticCollection: () => ({
        clear() {
          diagnosticsByFile.clear();
        },
        set(uri, list) {
          diagnosticsByFile.set(uri.fsPath, list);
        },
        dispose() {},
      }),
      registerCodeActionsProvider: () => noopDisposable,
    },
    commands: {
      registerCommand: (id, callback) => {
        commands.set(id, callback);
        return noopDisposable;
      },
      executeCommand: async () => undefined,
    },
    env: { clipboard: { writeText: async () => undefined } },
  };

  const context = {
    subscriptions: [],
    workspaceState: {
      get: (key) => storage[key],
      update: async (key, value) => {
        storage[key] = value;
      },
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    globalStorageUri: Uri.file(path.join(workspaceDir, ".cyclon-storage")),
  };

  return { vscode, commands, diagnosticsByFile, storage, context };
}

async function main() {
  const live = process.env.CYCLON_LIVE === "1";
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyclon-vscode-test-"));
  fs.writeFileSync(
    path.join(workspaceDir, "test.py"),
    "def divide(a, b):\n    return a / b\n",
    "utf8",
  );

  let server;
  if (!live) {
    server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const body = JSON.stringify({
          choices: [{ message: { content: JSON.stringify([FINDING]) } }],
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        response.end(body);
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    process.env.XAI_API_KEY = "smoke-test-key";
    process.env.XAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  }

  const mock = createVscodeMock(workspaceDir);
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return mock.vscode;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const extension = require(path.join(__dirname, "..", "dist", "extension.js"));
    extension.activate(mock.context);

    const missing = [
      "cyclon.scanWorkspace",
      "cyclon.scanFile",
      "cyclon.setApiKeys",
      "cyclon.showReport",
    ].filter((id) => !mock.commands.has(id));
    if (missing.length) {
      throw new Error(`Missing commands: ${missing.join(", ")}`);
    }

    await mock.commands.get("cyclon.scanWorkspace")();

    const target = path.join(workspaceDir, "test.py");
    const diagnostics = mock.diagnosticsByFile.get(target);
    if (!diagnostics || diagnostics.length === 0) {
      throw new Error(
        `Expected diagnostics for ${target}; got: ${JSON.stringify([...mock.diagnosticsByFile.keys()])}`,
      );
    }
    if (diagnostics[0].source !== "cyclon") {
      throw new Error(`Unexpected diagnostic source: ${diagnostics[0].source}`);
    }
    if (!live) {
      if (diagnostics[0].severity !== 0) {
        throw new Error(`Expected Error severity, got ${diagnostics[0].severity}`);
      }
      if (!diagnostics[0].message.includes("Division by zero")) {
        throw new Error(`Unexpected diagnostic message: ${diagnostics[0].message}`);
      }
    }

    const saved = mock.storage["cyclon.lastScan"];
    if (!saved || saved.findings.length < 1) {
      throw new Error("Scan result was not persisted to workspaceState");
    }

    extension.deactivate();
    console.log(`OK: ${diagnostics.length} diagnostic(s) published for ${target}`);
    console.log(`OK: ${mock.commands.size} commands registered, result persisted`);
  } finally {
    Module._load = originalLoad;
    if (server) {
      server.close();
    }
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error);
  process.exit(1);
});
