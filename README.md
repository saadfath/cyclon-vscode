# Cyclon for VS Code

Multi-agent AI code review inside VS Code, powered by the [cyclon](https://github.com/saadfath/cyclon) CLI and the xAI **Grok** API.

Cyclon scans your workspace with several specialist agents (security, bugs/logic, performance/quality) and brings the results back as native editor feedback:

- **Live dashboard** in the Cyclon sidebar: per-file progress, agent activity, a streaming event feed and severity counters — you see what is happening while the scan runs
- **Postman-style report**: sidebar navigation by severity / category / file, Overview + Findings + Raw JSON tabs, severity donut, search and sort, and one-click copy/open actions
- **Problems panel diagnostics** with severity, category and suggested fix
- **Findings tree** grouped by file, with severity filtering
- **Quick actions** on any diagnostic: show details / copy suggested fix
- **Finding details panel** with description and suggested fix
- **Status bar** progress (`3/12` while scanning) that turns red/amber when serious issues are found
- **Scan on save** (optional) that merges fresh results into existing findings

## Requirements

1. **VS Code 1.90+**
2. **The cyclon CLI** installed and on `PATH`:

   ```bash
   cd cli-cyclon
   pip install -e .
   ```

   The extension falls back to `python -m cyclon` if the `cyclon` executable is not found. You can also point it at a specific executable with `cyclon.command` / `cyclon.pythonPath`.
3. **An xAI API key** (or several, one per agent).

## Setup

1. Run **Cyclon: Set API Keys** from the Command Palette and paste your key(s).  
   Multiple keys can be comma-separated — one key per agent. Keys are stored in VS Code's **SecretStorage** (OS keychain), never in settings.
2. Open a folder and run **Cyclon: Scan Workspace**.

You can also use the environment variables the CLI already understands: `XAI_API_KEY`, `XAI_API_KEYS`, `GROK_API_KEY`, `GROK_API_KEYS`. Keys configured with `cyclon config set-key` (or in `~/.config/cyclon/config.json`) are picked up automatically.

## Commands

| Command | Description |
| --- | --- |
| `Cyclon: Scan Workspace` | Scan the whole workspace (prompts if there are multiple folders). |
| `Cyclon: Scan Current File` | Scan the active file. Merges results into existing findings. |
| `Cyclon: Scan This Path` | Right-click a file or folder in the Explorer. |
| `Cyclon: Cancel Scan` | Stop the running scan. |
| `Cyclon: Filter Findings by Severity` | Filter the findings tree. |
| `Cyclon: Open HTML Report` | Open the Postman-style report panel. |
| `Cyclon: Show Finding Details` | Open the details panel for a finding. |
| `Cyclon: Copy Suggested Fix` | Copy the suggested fix to the clipboard. |
| `Cyclon: Set API Keys` / `Clear Stored API Keys` | Manage secrets. |
| `Cyclon: Clear Findings` | Remove diagnostics and stored results. |
| `Cyclon: Show Output Log` | Show the raw CLI output. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cyclon.command` | `cyclon` | CLI executable. |
| `cyclon.pythonPath` | `python3` | Interpreter for the `-m cyclon` fallback. |
| `cyclon.model` | `""` | Grok model (empty = CLI default). |
| `cyclon.baseUrl` | `""` | Override the xAI base URL. |
| `cyclon.concurrency` | `4` | Concurrent file scans. |
| `cyclon.maxFileSize` | `200000` | Max file size in bytes. |
| `cyclon.extensions` | `[]` | Extensions to scan (empty = CLI defaults). |
| `cyclon.extraPrompt` | `""` | Extra instructions for the agents. |
| `cyclon.useCache` | `true` | Reuse cached findings for unchanged files. |
| `cyclon.scanOnSave` | `false` | Rescan the saved file automatically. |
| `cyclon.severityThreshold` | `info` | Minimum severity shown in Problems. |
| `cyclon.timeoutMinutes` | `20` | Abort long scans (0 disables). |
| `cyclon.openReportAfterScan` | `false` | Open the HTML report automatically. |

## Troubleshooting

- **HTTP 410 / 404 from the provider** — the model in `~/.config/cyclon/config.json` is retired or not enabled for your account. Update the `models` array (one model per API key) and rerun.
- **`Read timed out`** — the provider was slow. Cyclon retries automatically; you can also lower `cyclon.concurrency` or scan fewer files.
- **`No API key`** — run **Cyclon: Set API Keys**, or `cyclon config set-key <key>`.
- **`cyclon` not found** — `pip install -e cli-cyclon`, or set `cyclon.command` / `cyclon.pythonPath`.

## How it works

The extension is a thin, typed wrapper around the CLI:

```
VS Code  ──spawn──▶  cyclon scan <path> --json --no-open --html <report> --events
   ▲                                   │
   └──── JSON findings + HTML report ◀─┘
                     + JSONL live events (stderr)
```

The CLI emits machine-readable progress events (`@@cyclon@@ {json}` on stderr) while it scans. The extension parses them in real time to drive the dashboard and the status bar. If the installed CLI does not support `--events`, the extension automatically retries without it and falls back to plain output.

Findings are mapped to `vscode.Diagnostic`s (critical/high → Error, medium → Warning, low → Information, info → Hint) and published to the Problems panel. The report panel is rendered natively by the extension from the scan result. No scan logic is duplicated, so improvements to the CLI automatically flow into the extension.

## Development

```bash
npm install
npm run build        # bundle to dist/extension.js
npm run typecheck
npm test             # end-to-end smoke test (mocks VS Code + a fake xAI API)
npm run watch        # rebuild on change
```

Press `F5` (Run Extension) to launch an Extension Development Host.

Package a VSIX:

```bash
npm run package
code --install-extension cyclon-vscode-0.2.0.vsix
```

## Privacy

Cyclon sends the contents of scanned files to the xAI API. The extension itself stores only scan results and API keys (in SecretStorage). The extension is disabled in untrusted workspaces.

## License

MIT
