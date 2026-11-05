// Settings › AI agents (desktop): what an AI agent (Claude…) can do with
// Imference Desktop, the switch that lets it, and "Connect" for each app —
// Desktop finds what's already set up, downloads the Imference MCP server
// (and a Node.js, only when none fits) on demand, and writes the app's
// config (internal/mcpsetup, app_mcp.go).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Cpu,
  Images,
  Loader2,
  Lock,
  RefreshCw,
  Terminal,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ProgressBar } from "@/components/ui/progress";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/ds";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import type {
  AppSettings,
  LocalApiInfo,
  McpClient,
  McpConnectResult,
  McpEntry,
  McpProgress,
  McpStatus,
  ToolsSettings,
} from "@/lib/types";

type ClientId = McpClient["id"] | "other";

/** v >= min, dotted numbers ("0.5.0"). */
function atLeast(v: string | undefined, min: string): boolean {
  if (!v) return false;
  const seg = (s: string) => s.replace(/^v/, "").split(/[-+]/)[0].split(".").map((n) => Number(n) || 0);
  const [a, b] = [seg(v), seg(min)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AgentsPane({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const ts: ToolsSettings = draft.tools ?? {};
  const apiOn = !ts.localApiDisabled;

  // The local API follows the switch once the auto-save has landed.
  const [apiInfo, setApiInfo] = useState<LocalApiInfo | null>(null);
  useEffect(() => {
    const id = window.setTimeout(() => void api.getLocalApiInfo().then(setApiInfo).catch(() => {}), 700);
    return () => window.clearTimeout(id);
  }, [ts.localApiDisabled]);

  // Fast pass first (files only), then the full check (starts each configured
  // server once, looks up the latest release).
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api.mcpStatus(false));
      setStatus(await api.mcpStatus(true));
    } catch {
      /* the pane shows what it has */
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const [busy, setBusy] = useState<ClientId | "update" | null>(null);
  const [progress, setProgress] = useState<McpProgress | null>(null);
  useEffect(() => api.onMcpProgress(setProgress), []);
  const [result, setResult] = useState<{ client: ClientId; res?: McpConnectResult; error?: string } | null>(null);

  const connect = async (client: ClientId) => {
    setBusy(client);
    setProgress(null);
    setResult(null);
    try {
      const res = await api.connectMcp(client);
      setResult({ client, res });
      if (res.done) toast.toast(t("agents.connected"));
    } catch (e) {
      setResult({ client, error: errText(e) });
    } finally {
      setBusy(null);
      setProgress(null);
      void refresh();
    }
  };

  const update = async () => {
    setBusy("update");
    setProgress(null);
    try {
      await api.updateMcp();
      toast.toast(t("agents.updated"));
    } catch (e) {
      toast.toast(errText(e));
    } finally {
      setBusy(null);
      setProgress(null);
      void refresh();
    }
  };

  const desktopCopy = status?.installs.find((i) => i.kind === "desktop");

  return (
    <div className="grid gap-6">
      {/* What it is. */}
      <section className="ds-card grid gap-5 p-6">
        <div className="flex items-start gap-4">
          <span className="brand-surface grid size-11 shrink-0 place-items-center rounded-xl text-white">
            <Bot className="size-5" />
          </span>
          <div className="grid gap-1.5">
            <h3 className="font-display text-lg font-semibold leading-tight">{t("agents.title")}</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{t("agents.lead")}</p>
          </div>
        </div>
        <ul className="grid gap-x-8 gap-y-3.5 text-sm leading-relaxed sm:grid-cols-2">
          {(
            [
              ["point1", Cpu],
              ["point2", Wand2],
              ["point3", Images],
              ["point4", Lock],
            ] as const
          ).map(([k, Icon]) => (
            <li key={k} className="flex items-start gap-3">
              <Icon className="text-[var(--brand-from)] mt-0.5 size-4 shrink-0" />
              <span>{t(`agents.${k}`)}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* What agents may do. */}
      <section className="ds-card grid gap-0 p-0">
        <h3 className="px-6 pb-1 pt-5 text-sm font-semibold">{t("agents.permissionsTitle")}</h3>
        <PermissionRow
          checked={apiOn}
          onChange={(on) => setDraft((d) => ({ ...d, tools: { ...(d.tools ?? {}), localApiDisabled: !on || undefined } }))}
          title={t("agents.allow")}
          hint={t("agents.allowHint")}
        >
          {apiInfo && (
            <details className="text-muted-foreground mt-2 text-xs">
              <summary className="hover:text-foreground cursor-pointer select-none">{t("agents.details")}</summary>
              <p className="mt-1.5 break-all font-mono text-2xs leading-relaxed">
                {apiInfo.running
                  ? t("tools.settings.apiRunning", { port: apiInfo.port, path: apiInfo.discoveryPath })
                  : t("tools.settings.apiStopped")}
              </p>
            </details>
          )}
        </PermissionRow>
        <PermissionRow
          checked={!!ts.agentsCanSpend}
          disabled={!apiOn}
          onChange={(on) => setDraft((d) => ({ ...d, tools: { ...(d.tools ?? {}), agentsCanSpend: on || undefined } }))}
          title={t("agents.spend")}
          hint={status && !status.apiKeySet ? t("agents.spendNoKey") : t("agents.spendHint")}
        />
      </section>

      {/* Connect an app. */}
      <section className="ds-card grid gap-4 p-6">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">{t("agents.connectTitle")}</h3>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={checking || busy !== null}>
            <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
            {t("agents.recheck")}
          </Button>
        </div>
        {!apiOn && (
          <p className="ds-callout ds-callout-warning px-4 py-3 text-sm leading-relaxed">{t("agents.apiOffWarning")}</p>
        )}

        {status ? (
          <ul className="grid gap-3">
            {status.clients.map((c) => (
              <ClientRow
                key={c.id}
                client={c}
                minVersion={status.minVersion}
                busy={busy}
                onConnect={() => void connect(c.id)}
              />
            ))}
            <li className="ds-card flex items-center gap-4 px-4 py-3.5">
              <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-lg">
                <Terminal className="size-4" />
              </span>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="text-sm font-medium">{t("agents.otherApp")}</p>
                <p className="text-muted-foreground text-xs leading-relaxed">{t("agents.otherHint")}</p>
              </div>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void connect("other")}>
                {busy === "other" ? <Loader2 className="size-3.5 animate-spin" /> : <ChevronRight className="size-3.5" />}
                {t("agents.showSetup")}
              </Button>
            </li>
          </ul>
        ) : (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-3.5 animate-spin" />
            {t("agents.detecting")}
          </p>
        )}

        {busy && busy !== "update" && (
          <DownloadProgress progress={progress} />
        )}
        {result && <ConnectOutcome result={result} />}
      </section>

      {/* What's installed. */}
      {status && (
        <section className="text-muted-foreground -mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-xs">
          <span>
            {t("agents.serverLine", {
              version: status.scriptVersion ? `v${status.scriptVersion}` : t("agents.notInstalled"),
            })}
            {desktopCopy ? ` (${t("agents.desktopCopy")})` : status.script ? ` (npm)` : ""}
          </span>
          <span>
            {status.node
              ? t("agents.nodeLine", {
                  version: status.node.version,
                  source: t(status.node.source === "desktop" ? "agents.nodeDesktop" : "agents.nodeSystem"),
                })
              : t("agents.nodeNone")}
          </span>
          {status.updateAvailable && (
            <Button variant="outline" size="sm" className="h-6 px-2 text-2xs" disabled={busy !== null} onClick={() => void update()}>
              {busy === "update" ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {t("agents.update", { version: status.latest })}
            </Button>
          )}
          {busy === "update" && <DownloadProgress progress={progress} />}
        </section>
      )}
    </div>
  );
}

/** One permission: a switch, its name and what it means, on its own row. */
function PermissionRow({
  checked,
  disabled,
  onChange,
  title,
  hint,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  title: string;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-3.5 border-t px-6 py-4 first-of-type:border-t-0", disabled && "opacity-60")}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <div className="grid min-w-0 flex-1 gap-1">
        <label className="text-sm font-medium" onClick={() => !disabled && onChange(!checked)}>
          {title}
        </label>
        <p className="text-muted-foreground text-[13px] leading-relaxed">{hint}</p>
        {children}
      </div>
    </div>
  );
}

function ClientRow({
  client,
  minVersion,
  busy,
  onConnect,
}: {
  client: McpClient;
  minVersion: string;
  busy: string | null;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  const user = client.entries.filter((e) => e.scope === "user");
  const projects = client.entries.filter((e) => e.scope !== "user");
  const entry: McpEntry | undefined = user.find((e) => e.name === "imference") ?? user[0];
  const failed = entry?.health === "failed";
  const outdated = entry?.health === "ok" && entry.version !== undefined && !atLeast(entry.version, minVersion);
  const ok = entry && !failed && !outdated;

  let line: string;
  if (!entry) line = client.installed ? t("agents.notConnected") : t("agents.notFound", { name: client.name });
  else if (failed) line = t("agents.failed");
  else if (outdated) line = t("agents.outdated", { version: entry.version });
  else line = t(`agents.mode.${entry.mode}`, { version: entry.version ?? "" });

  return (
    <li className="ds-card grid gap-3 px-4 py-3.5" data-testid={`mcp-client-${client.id}`}>
      <div className="flex items-center gap-4">
        <span className="bg-muted text-foreground grid size-9 shrink-0 place-items-center rounded-lg">
          <Bot className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {client.name}
            {ok && (
              <Badge tone="success">
                <Check />
                {t("agents.connectedBadge")}
              </Badge>
            )}
            {(failed || outdated) && (
              <Badge tone="warning">
                <AlertTriangle />
                {t(failed ? "agents.failedBadge" : "agents.outdatedBadge")}
              </Badge>
            )}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed" title={entry?.healthError ?? line}>
            {line}
          </p>
        </div>
        <Button
          variant={entry && ok ? "outline" : "brand"}
          size="sm"
          disabled={busy !== null}
          onClick={onConnect}
        >
          {busy === client.id && <Loader2 className="size-3.5 animate-spin" />}
          {!entry ? t("agents.connect") : ok ? t("agents.reconnect") : t("agents.repair")}
        </Button>
      </div>
      {failed && entry?.healthError && (
        <p className="ds-callout ds-callout-warning break-words px-3 py-2.5 font-mono text-2xs leading-relaxed">{entry.healthError}</p>
      )}
      {projects.length > 0 && (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("agents.projectEntries", { count: projects.length, projects: projects.map((p) => p.scope).join(", ") })}
        </p>
      )}
    </li>
  );
}

function DownloadProgress({ progress }: { progress: McpProgress | null }) {
  const { t } = useTranslation();
  const label =
    progress?.stage === "node"
      ? t("agents.downloadingNode")
      : progress?.stage === "server"
        ? t("agents.downloadingServer")
        : t("agents.preparing");
  return (
    <div className="grid gap-1.5" aria-live="polite">
      <p className="text-muted-foreground flex items-center justify-between text-sm">
        <span>{label}</span>
        {progress && progress.percent > 0 && progress.stage !== "done" && <span className="tabular-nums">{progress.percent}%</span>}
      </p>
      <ProgressBar percent={progress && progress.stage !== "done" ? progress.percent : null} />
    </div>
  );
}

function ConnectOutcome({ result }: { result: { client: ClientId; res?: McpConnectResult; error?: string } }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const { res, error } = result;
  const manual = res?.manual;
  const copy = () => {
    if (!manual) return;
    void navigator.clipboard?.writeText(manual).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="grid gap-3" data-testid="mcp-outcome">
      {error && <p className="ds-callout ds-callout-danger px-4 py-3 text-sm leading-relaxed">{error}</p>}
      {res?.done && (
        <div className="ds-callout ds-callout-info grid gap-1.5 px-4 py-3 text-sm leading-relaxed">
          <p className="font-medium">
            {t(result.client === "claude-desktop" ? "agents.doneClaudeDesktop" : "agents.doneClaudeCode")}
          </p>
          <p className="text-foreground/80">{t("agents.tryIt")}</p>
          {res.backup && <p className="text-muted-foreground break-all text-xs">{t("agents.backup", { path: res.backup })}</p>}
        </div>
      )}
      {manual && (
        <div className="grid gap-1.5">
          <p className="text-sm leading-relaxed">{t(result.client === "other" ? "agents.manualOther" : "agents.manualClaudeCode")}</p>
          <div className="relative">
            <pre className="bg-muted max-h-48 overflow-auto rounded-lg p-3 pr-10 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all">
              {manual}
            </pre>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 size-7"
              onClick={copy}
              aria-label={t("common.copy")}
            >
              {copied ? <Check className="text-success size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
