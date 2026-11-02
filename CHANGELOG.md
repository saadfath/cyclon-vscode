# Changelog

## 0.2.0

- New **live dashboard** in the Cyclon sidebar: scan progress, per-agent activity, streaming event feed, severity counters and elapsed time.
- New **Postman-style report panel**: sidebar navigation (severity / category / file), Overview / Findings / Raw JSON tabs, severity donut, top categories, search and sort, copy/open actions.
- The CLI now supports `cyclon scan --events`, a JSONL progress stream consumed by the extension.
- Status bar shows live `done/total` file progress while scanning.
- Restyled the finding details panel.
- Removed the separate Overview tree (replaced by the dashboard).
- Graceful fallback for older CLIs that do not support `--events`.

## 0.1.0

- Initial release.
- Scan workspace, current file, or any Explorer path with the cyclon CLI.
- Findings published as Problems diagnostics with quick actions.
- Findings tree with severity filtering and an overview view.
- Finding details panel with copy-fix action.
- HTML report webview.
- Status bar summary, cancelable progress, scan-on-save.
- API keys stored in VS Code SecretStorage.
