# Codex Usage (Business)

Displays Codex Business usage and spend-limit information in the VS Code status bar.

The extension reads the same local credentials as the Codex CLI from
`~/.codex/auth.json` and requests usage directly from the ChatGPT usage API.
Credentials remain in the local VS Code extension host and are never logged.

## At a Glance

The status bar shows the current percentage of the applicable Codex spend limit.

![Codex Usage status-bar item showing 11 percent usage](https://raw.githubusercontent.com/jcarruthers-vix/vscode-codex-usage-checker/main/images/statusbar_usage_summary.png)

Hover over the status-bar item to see the usage, remaining allowance, reset time,
account, plan, and a refresh link.

![Codex Usage hover panel with spend-limit details and refresh link](https://raw.githubusercontent.com/jcarruthers-vix/vscode-codex-usage-checker/main/images/statusbar_hover_detail_information.png)

## Features

- Compact current usage percentage in the status bar.
- Warning state when a rate limit or spend limit has been reached.
- Hover details for usage, remaining allowance, reset time, account, and plan.
- Click-to-refresh status bar item and `Codex Usage (Business): Refresh` command.
- Automatic refresh every five minutes by default.

## Diagnostics

If some usage details are unavailable, run `Codex Usage (Business): Show Diagnostics`
from the Command Palette. It refreshes the data and opens the `Codex Usage (Business)`
Output panel with the API response fields and display-field availability. Access tokens,
and authentication data are never included. The raw API response does include account
and usage data, including the email address and account IDs, so redact it before sharing.

## Development

```sh
npm install
npm run compile
```

Open this directory in VS Code and press `F5` to launch an Extension Development
Host. To install it normally, package it as a VSIX and install that VSIX in VS Code.

## Settings

- `codexUsageBiz.accountDirectory`: directory containing Codex auth files.
- `codexUsageBiz.accountName`: optional named account, loaded as `<name>.auth.json`.
- `codexUsageBiz.dateLocale`: optional date locale such as `en-AU`; defaults to the
  VS Code display language.
- `codexUsageBiz.refreshIntervalMinutes`: automatic refresh interval; `0` disables it.
- `codexUsageBiz.requestTimeoutSeconds`: API request timeout.
