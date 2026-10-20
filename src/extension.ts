import * as fs from "node:fs/promises";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type JsonObject = Record<string, unknown>;

interface Credentials {
  accessToken: string;
  accountId: string;
}

interface UsageSummary {
  limitReached: boolean;
  reachedReason: string | undefined;
  used: number | undefined;
  limit: number | undefined;
  remaining: number | undefined;
  usedPercent: number | undefined;
  resetAt: Date | undefined;
  email: string | undefined;
  planType: string | undefined;
  limitSource: string | undefined;
}

interface UsageResponse {
  data: JsonObject;
  statusCode: number;
}

class CodexUsageStatus implements vscode.Disposable {
  private readonly statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  private readonly outputChannel = vscode.window.createOutputChannel(
    "Codex Usage (Business)",
  );
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private diagnosticsActive = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBarItem.name = "Codex Usage";
    this.statusBarItem.command = "codexUsageBiz.refresh";
    this.statusBarItem.text = "$(sync~spin) Codex usage";
    this.statusBarItem.tooltip = "Checking Codex usage...";
    this.statusBarItem.show();

    context.subscriptions.push(
      this.statusBarItem,
      vscode.commands.registerCommand("codexUsageBiz.refresh", () => this.refresh(true)),
      vscode.commands.registerCommand(
        "codexUsageBiz.showDiagnostics",
        () => this.showDiagnostics(),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codexUsageBiz")) {
          this.scheduleRefresh();
          void this.refresh(false);
        }
      }),
    );
    context.subscriptions.push(this.outputChannel);

    this.scheduleRefresh();
  }

  refresh(showErrors: boolean): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.statusBarItem.text = "$(sync~spin) Codex usage";
    this.refreshInFlight = this.performRefresh(showErrors).finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  private async performRefresh(showErrors: boolean): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration("codexUsageBiz");
      const authPath = getAuthPath(
        config.get<string>("accountDirectory", "~/.codex"),
        config.get<string>("accountName", ""),
      );
      const credentials = await loadCredentials(authPath);
      const timeoutSeconds = config.get<number>("requestTimeoutSeconds", 30);
      const response = await requestUsage(credentials, timeoutSeconds * 1000);
      const summary = summarizeUsage(response.data);
      this.renderUsage(summary);
      if (this.diagnosticsActive) {
        this.logUsageDiagnostics(authPath, timeoutSeconds, response, summary);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(
        `[${new Date().toISOString()}] Refresh failed: ${sanitizeDiagnosticText(message)}`,
      );
      this.renderError(message);
      if (showErrors) {
        void vscode.window.showErrorMessage(`Unable to refresh Codex usage: ${message}`);
      }
    }
  }

  private async showDiagnostics(): Promise<void> {
    this.outputChannel.clear();
    this.outputChannel.appendLine("Codex Usage (Business) diagnostics");
    this.outputChannel.appendLine(`Timestamp: ${new Date().toISOString()}`);
    this.outputChannel.appendLine(`VS Code: ${vscode.version}`);
    this.outputChannel.appendLine(`Extension host: ${vscode.env.remoteName ?? "local"}`);
    this.outputChannel.appendLine(
      "The raw response below includes account and usage information. Redact it before sharing.",
    );
    this.outputChannel.appendLine("");

    this.diagnosticsActive = true;
    try {
      await this.refresh(false);
    } finally {
      this.diagnosticsActive = false;
      this.outputChannel.show(true);
    }
  }

  private logUsageDiagnostics(
    authPath: string,
    timeoutSeconds: number,
    response: UsageResponse,
    summary: UsageSummary,
  ): void {
    const data = response.data;
    const spendControl = asObject(data.spend_control);
    const individualLimit = asObject(spendControl?.individual_limit);

    this.outputChannel.appendLine("Usage request succeeded.");
    this.outputChannel.appendLine(`HTTP status: ${response.statusCode}`);
    this.outputChannel.appendLine(`Auth file: ${sanitizePath(authPath)}`);
    this.outputChannel.appendLine(`Request timeout: ${timeoutSeconds} seconds`);
    this.outputChannel.appendLine(
      `Response fields: ${Object.keys(data).sort().join(", ") || "none"}`,
    );
    this.outputChannel.appendLine(
      `Spend-limit fields: ${individualLimit ? Object.keys(individualLimit).sort().join(", ") || "none" : "spend_control.individual_limit unavailable"}`,
    );
    this.outputChannel.appendLine("");
    this.outputChannel.appendLine("Display field availability:");
    this.outputChannel.appendLine(`  Usage: ${fieldAvailability(summary.used, summary.limit)}`);
    this.outputChannel.appendLine(`  Usage percentage: ${fieldAvailability(summary.usedPercent)}`);
    this.outputChannel.appendLine(`  Remaining allowance: ${fieldAvailability(summary.remaining)}`);
    this.outputChannel.appendLine(`  Reset time: ${fieldAvailability(summary.resetAt)}`);
    this.outputChannel.appendLine(`  Account: ${fieldAvailability(summary.email)}`);
    this.outputChannel.appendLine(`  Plan: ${fieldAvailability(summary.planType)}`);
    this.outputChannel.appendLine(`  Limit source: ${fieldAvailability(summary.limitSource)}`);
    this.outputChannel.appendLine(
      `  Limit reached: ${summary.limitReached ? "reported as reached" : "not reported as reached"}`,
    );
    this.outputChannel.appendLine("");
    this.outputChannel.appendLine(
      "Raw API response (no access token is included, but redact before sharing):",
    );
    this.outputChannel.appendLine(JSON.stringify(data, null, 2));
  }

  private renderUsage(summary: UsageSummary): void {
    const percentage = formatPercent(summary.usedPercent);
    this.statusBarItem.text = summary.limitReached
      ? "$(error) Codex limit reached"
      : `$(pulse) Codex ${percentage}`;
    this.statusBarItem.backgroundColor = summary.limitReached
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : undefined;

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = { enabledCommands: ["codexUsageBiz.refresh"] };
    tooltip.appendMarkdown("### Codex usage\n\n");
    tooltip.appendMarkdown(
      `**Status:** ${summary.limitReached ? `Limit reached${summary.reachedReason ? ` (${escapeMarkdown(summary.reachedReason)})` : ""}` : "Available"}  \n`,
    );
    tooltip.appendMarkdown(
      `**Usage:** ${formatNumber(summary.used)} / ${formatNumber(summary.limit)} (${percentage})  \n`,
    );
    tooltip.appendMarkdown(`**Remaining:** ${formatNumber(summary.remaining)}  \n`);
    tooltip.appendMarkdown(`**Resets:** ${formatDate(summary.resetAt)}  \n`);

    if (summary.email || summary.planType) {
      tooltip.appendMarkdown("\n---\n\n");
      if (summary.email) {
        tooltip.appendMarkdown(`**Account:** ${escapeMarkdown(summary.email)}  \n`);
      }
      if (summary.planType) {
        tooltip.appendMarkdown(`**Plan:** ${escapeMarkdown(summary.planType)}  \n`);
      }
      if (summary.limitSource) {
        tooltip.appendMarkdown(`**Limit source:** ${escapeMarkdown(summary.limitSource)}  \n`);
      }
    }

    tooltip.appendMarkdown(`\n_Last checked: ${formatDate(new Date())}_  \n`);
    tooltip.appendMarkdown("[$(refresh) Refresh now](command:codexUsageBiz.refresh)");
    this.statusBarItem.tooltip = tooltip;
  }

  private renderError(message: string): void {
    this.statusBarItem.text = "$(warning) Codex usage";
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );

    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = { enabledCommands: ["codexUsageBiz.refresh"] };
    tooltip.appendMarkdown("### Codex usage unavailable\n\n");
    tooltip.appendMarkdown(`${escapeMarkdown(message)}\n\n`);
    tooltip.appendMarkdown("[$(refresh) Try again](command:codexUsageBiz.refresh)");
    this.statusBarItem.tooltip = tooltip;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    const minutes = vscode.workspace
      .getConfiguration("codexUsageBiz")
      .get<number>("refreshIntervalMinutes", 5);
    if (minutes > 0) {
      this.refreshTimer = setInterval(() => void this.refresh(false), minutes * 60_000);
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const usageStatus = new CodexUsageStatus(context);
  context.subscriptions.push(usageStatus);
  void usageStatus.refresh(false);
}

export function deactivate(): void {}

function getAuthPath(accountDirectory: string, accountName: string): string {
  const expandedDirectory = accountDirectory === "~"
    ? os.homedir()
    : accountDirectory.startsWith("~/")
      ? path.join(os.homedir(), accountDirectory.slice(2))
      : accountDirectory;
  const trimmedName = accountName.trim();
  const fileName = trimmedName ? `${trimmedName}.auth.json` : "auth.json";
  return path.resolve(expandedDirectory, fileName);
}

async function loadCredentials(authPath: string): Promise<Credentials> {
  let auth: unknown;
  try {
    auth = JSON.parse(await fs.readFile(authPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${authPath}: ${reason}`);
  }

  const root = asObject(auth);
  const accessToken = firstString(
    root?.access_token,
    root?.accessToken,
    nestedValue(root, "tokens", "access_token"),
    nestedValue(root, "tokens", "accessToken"),
  );
  const accountId = firstString(
    root?.account_id,
    root?.accountId,
    nestedValue(root, "tokens", "account_id"),
    nestedValue(root, "tokens", "accountId"),
  );

  if (!accessToken) {
    throw new Error(`Missing access token in ${authPath}`);
  }
  if (!accountId) {
    throw new Error(`Missing account ID in ${authPath}`);
  }
  return { accessToken, accountId };
}

function requestUsage(credentials: Credentials, timeoutMs: number): Promise<UsageResponse> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      USAGE_URL,
      {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          Accept: "application/json",
          "ChatGPT-Account-Id": credentials.accountId,
          Origin: "https://chatgpt.com",
          Referer: "https://chatgpt.com/",
          "User-Agent": "Mozilla/5.0",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            reject(new Error(`Usage API returned HTTP ${response.statusCode ?? "unknown"} with invalid JSON`));
            return;
          }

          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(getApiError(parsed) ?? `Usage API returned HTTP ${response.statusCode}`));
            return;
          }

          const data = asObject(parsed);
          if (!data) {
            reject(new Error("Usage API returned an unexpected response"));
            return;
          }
          resolve({ data, statusCode: response.statusCode ?? 200 });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Usage API request timed out after ${timeoutMs / 1000} seconds`));
    });
    request.on("error", reject);
  });
}

function summarizeUsage(data: JsonObject): UsageSummary {
  const spendControl = asObject(data.spend_control);
  const individualLimit = asObject(spendControl?.individual_limit);
  const credits = asObject(data.credits);
  const reachedReason = stringValue(data.rate_limit_reached_type);
  const used = numberValue(individualLimit?.used);
  const limit = numberValue(individualLimit?.limit);
  const explicitPercent = numberValue(individualLimit?.used_percent);
  const usedPercent = explicitPercent ?? (
    used !== undefined && limit !== undefined && limit !== 0 ? (used / limit) * 100 : undefined
  );

  return {
    limitReached:
      spendControl?.reached === true ||
      credits?.overage_limit_reached === true ||
      reachedReason !== undefined,
    reachedReason,
    used,
    limit,
    remaining: numberValue(individualLimit?.remaining),
    usedPercent,
    resetAt: dateFromTimestamp(individualLimit?.reset_at),
    email: stringValue(data.email),
    planType: stringValue(data.plan_type),
    limitSource: stringValue(individualLimit?.source),
  };
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function nestedValue(root: JsonObject | undefined, ...keys: string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    current = asObject(current)?.[key];
  }
  return current;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function dateFromTimestamp(value: unknown): Date | undefined {
  const raw = numberValue(value);
  if (raw === undefined) {
    return undefined;
  }
  const timestamp = raw > 100_000_000_000 ? raw : raw * 1000;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatNumber(value: number | undefined): string {
  return value === undefined
    ? "Unavailable"
    : new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
}

function formatPercent(value: number | undefined): string {
  return value === undefined
    ? "Unavailable"
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}%`;
}

function formatDate(value: Date | undefined): string {
  if (value === undefined) {
    return "Unavailable";
  }

  const configuredLocale = vscode.workspace
    .getConfiguration("codexUsageBiz")
    .get<string>("dateLocale", "")
    .trim();
  const locale = configuredLocale || vscode.env.language || undefined;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  };

  try {
    return new Intl.DateTimeFormat(locale, options).format(value);
  } catch (error) {
    if (error instanceof RangeError) {
      return new Intl.DateTimeFormat(undefined, options).format(value);
    }
    throw error;
  }
}

function getApiError(value: unknown): string | undefined {
  const data = asObject(value);
  return stringValue(data?.detail) ?? stringValue(data?.message) ?? stringValue(data?.error);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, "\\$&");
}

function fieldAvailability(...values: unknown[]): string {
  return values.every((value) => value !== undefined) ? "available" : "unavailable";
}

function sanitizePath(value: string): string {
  const homeDirectory = os.homedir();
  return value.startsWith(homeDirectory)
    ? `~${value.slice(homeDirectory.length)}`
    : "configured path";
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replaceAll(os.homedir(), "~")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/user-[A-Za-z0-9_-]+/g, "user-[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email redacted]");
}
