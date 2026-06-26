import { useEffect, useState } from "react";
import { Settings, Cloud, Cpu, Loader2, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { SettingsDialog } from "@/components/SettingsDialog";
import { LogPanel } from "@/components/LogPanel";
import { api } from "@/lib/wails-bridge";
import { installLogCapture } from "@/lib/log-capture";
import type {
  AppSettings,
  GenerationResult,
  LogEntry,
  SidecarStatus,
} from "@/lib/types";

// Module-load side effect: install console + window error hooks before any
// component renders. The api wrapping itself happens inside wails-bridge.ts
// so SettingsDialog and any future component that imports `api` get the
// logged version automatically.
installLogCapture();

// Bumped to SDXL-native resolution (1024) + 20 steps to assess actual quality.
// Was {512, 512, 12, 6.0} for fast pipeline-verification iteration. Either
// keep these new defaults, or surface as inputs in the UI to let the user
// trade speed vs quality per gen.
const DEFAULT_PARAMS = {
  width: 1024,
  height: 1024,
  numSteps: 20,
  guidanceScale: 6.0,
  // Critical on Illustrious / NoobAI / Pony-derived models — without this
  // they emit watermarks, monochrome fragments, and generally low-quality
  // outputs. Keep this as the floor and add prompt-specific tags via UI.
  negativePrompt:
    "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry, monochrome",
};

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sidecar, setSidecar] = useState<SidecarStatus>({ state: "idle" });
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState<"local" | "cloud" | null>(null);
  const [image, setImage] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [errorLogCount, setErrorLogCount] = useState(0);

  useEffect(() => {
    void api.getSettings().then(setSettings);
    void api.getSidecarStatus().then(setSidecar);
    return api.onSidecarStatus(setSidecar);
  }, []);

  // Header badge: tally of error-level entries since last panel open. Resets
  // when the user opens the panel (they've now seen them).
  useEffect(() => {
    void api.getLogs().then((seed: LogEntry[]) => {
      setErrorLogCount(seed.filter((e) => e.level === "error").length);
    });
    return api.onLogEntry((e) => {
      if (e.level === "error") setErrorLogCount((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    if (logsOpen) setErrorLogCount(0);
  }, [logsOpen]);

  const cloudReady = !!settings?.apiKey && !!settings?.cloudModel;
  const localReady = sidecar.state === "ready";

  const runCloud = async () => {
    if (!settings || !cloudReady || !prompt.trim()) return;
    setRunning("cloud");
    setError(null);
    try {
      const result = await api.generateCloud({
        prompt: prompt.trim(),
        ...DEFAULT_PARAMS,
      });
      setImage(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  const runLocal = async () => {
    if (sidecar.state !== "ready" || !prompt.trim()) return;
    setRunning("local");
    setError(null);
    try {
      const result = await api.generateLocal({
        prompt: prompt.trim(),
        ...DEFAULT_PARAMS,
      });
      setImage(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Imference Desktop</h1>
          <SidecarPill status={sidecar} />
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLogsOpen((o) => !o)}
            aria-label="Logs"
            className="relative gap-1.5"
          >
            <ScrollText className="size-4" />
            Logs
            {errorLogCount > 0 && (
              <span className="bg-destructive text-destructive-foreground absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold">
                {errorLogCount > 99 ? "99+" : errorLogCount}
              </span>
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          >
            <Settings className="size-5" />
          </Button>
        </div>
      </header>

      <main className="mx-auto grid max-w-4xl gap-6 px-6 py-8">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <section className="grid gap-3">
          <label htmlFor="prompt" className="text-sm font-medium">
            Prompt
          </label>
          <Textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="a cat sitting on a wooden table, photorealistic"
            className="min-h-28"
          />
          <div className="flex gap-3">
            <Button
              onClick={runCloud}
              disabled={!cloudReady || !prompt.trim() || running !== null}
              className="flex-1"
            >
              {running === "cloud" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Cloud className="size-4" />
              )}
              Run Cloud
            </Button>
            <Button
              variant="outline"
              onClick={runLocal}
              disabled={!localReady || !prompt.trim() || running !== null}
              className="flex-1"
              title={
                sidecar.state === "ready"
                  ? `Local sidecar ready on ${sidecar.device}`
                  : sidecar.state === "error"
                    ? sidecar.message
                    : "Local sidecar not ready"
              }
            >
              {running === "local" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Cpu className="size-4" />
              )}
              Run Local
            </Button>
          </div>
        </section>

        <Card>
          <CardContent>
            {image ? (
              <div className="flex flex-col items-center gap-3">
                <img
                  src={image.imageBase64}
                  alt="Generated"
                  className="max-h-[600px] w-auto rounded-md"
                />
                <div className="flex flex-col items-center gap-1 text-xs">
                  <p className="text-muted-foreground">
                    source: {image.source} · seed: {image.seed}
                  </p>
                  {image.savedPath ? (
                    <p
                      className="text-muted-foreground/80 max-w-[600px] truncate font-mono"
                      title={image.savedPath}
                    >
                      saved: {image.savedPath}
                    </p>
                  ) : (
                    <p className="text-yellow-600">not saved to disk</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground py-12 text-center text-sm">
                {running ? "Generating…" : "No image yet."}
              </p>
            )}
          </CardContent>
        </Card>
      </main>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={(next) => {
          setSettings(next);
        }}
      />

      <LogPanel open={logsOpen} onOpenChange={setLogsOpen} />
    </div>
  );
}

function SidecarPill({ status }: { status: SidecarStatus }) {
  const label =
    status.state === "ready"
      ? `local: ready (${status.device})`
      : status.state === "starting"
        ? "local: starting"
        : status.state === "error"
          ? "local: error"
          : status.state === "stopped"
            ? "local: stopped"
            : "local: idle";

  const colorClass =
    status.state === "ready"
      ? "bg-green-500/15 text-green-700"
      : status.state === "starting"
        ? "bg-yellow-500/15 text-yellow-700"
        : status.state === "error"
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground";

  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${colorClass}`}
      title={status.state === "error" ? status.message : undefined}
    >
      {label}
    </span>
  );
}
