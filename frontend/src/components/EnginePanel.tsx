import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Cpu, Loader2, MemoryStick, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import type { EngineStatusInfo, GenerationMode, ModelInfo, SidecarStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// EnginePanel — "what runs where": the Local / Cloud switch, payment and model
// (the engine block that used to sit atop Create), plus the machine's side of
// it in local mode: the GPU, the generation model the engine holds, and the
// small tool models loaded next to it.
// ---------------------------------------------------------------------------

/** Polls App.EngineStatus while shown (local mode). */
export function useEngineStatus(active: boolean, refreshKey?: unknown) {
  const [status, setStatus] = useState<EngineStatusInfo | null>(null);
  const refresh = useCallback(() => {
    void api
      .engineStatus()
      .then((s) =>
        // A busy tools sidecar answers no list: keep the last one.
        setStatus((prev) => (s.toolsBusy && prev ? { ...s, toolsWarm: prev.toolsWarm } : s))
      )
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!active) return;
    refresh();
    const id = window.setInterval(refresh, 4000);
    return () => window.clearInterval(id);
  }, [active, refresh, refreshKey]);
  return { status, refresh };
}

function mb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function SidecarPill({ sidecar }: { sidecar: SidecarStatus }) {
  const { t } = useTranslation();
  const tone =
    sidecar.state === "ready"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : sidecar.state === "starting"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : sidecar.state === "error"
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", tone)}>
      {sidecar.state === "starting" && <Loader2 className="size-3 animate-spin" />}
      {t(`engine.state.${sidecar.state}`)}
    </span>
  );
}

export function EnginePanel({
  engineBlock,
  mode,
  sidecar,
  localModel,
  loraCount,
}: {
  engineBlock: ReactNode;
  mode: GenerationMode;
  sidecar: SidecarStatus;
  localModel: ModelInfo | null | undefined;
  loraCount: number;
}) {
  const { t } = useTranslation();
  const local = mode === "local";
  const { status, refresh } = useEngineStatus(local, sidecar.state);
  const [releasing, setReleasing] = useState(false);
  const warm = status?.toolsWarm ?? [];
  const warmBytes = warm.reduce((n, w) => n + w.bytes, 0);

  return (
    <div className="flex flex-col gap-3">
      {engineBlock}

      {local ? (
        <>
          {/* The machine */}
          <section className="rounded-xl border p-3 text-xs">
            <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
              <MemoryStick className="size-3.5" /> {t("engine.machine")}
            </p>
            <p className="font-medium">{status?.gpuName || t("engine.noGpu")}</p>
            {!!status?.vramGiB && (
              <p className="text-muted-foreground">{t("engine.vram", { gb: status.vramGiB.toFixed(1) })}</p>
            )}
          </section>

          {/* The generation model the engine holds */}
          <section className="rounded-xl border p-3 text-xs">
            <div className="mb-1.5 flex items-center gap-2">
              <p className="text-muted-foreground flex flex-1 items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                <Cpu className="size-3.5" /> {t("engine.generation")}
              </p>
              <SidecarPill sidecar={sidecar} />
            </div>
            <p className="font-medium">{localModel ? localModel.name || localModel.modelCode : t("engine.noModel")}</p>
            {loraCount > 0 && <p className="text-muted-foreground">{t("engine.loras", { count: loraCount })}</p>}
            {sidecar.state === "ready" && "device" in sidecar && (
              <p className="text-muted-foreground">{t("engine.device", { device: sidecar.device })}</p>
            )}
          </section>

          {/* The small tool models loaded next to it */}
          <section className="rounded-xl border p-3 text-xs">
            <div className="mb-1.5 flex items-center gap-2">
              <p className="text-muted-foreground flex flex-1 items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
                <Wrench className="size-3.5" /> {t("engine.tools")}
              </p>
              {status?.toolsBusy && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
            </div>
            {warm.length === 0 ? (
              <p className="text-muted-foreground">{status?.toolsUp ? t("engine.toolsIdle") : t("engine.toolsOff")}</p>
            ) : (
              <>
                <ul className="space-y-0.5">
                  {warm.map((w) => (
                    <li key={w.name} className="flex items-center gap-2">
                      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                      <span className="min-w-0 flex-1 truncate" title={`${w.name} · ${w.runtime}`}>
                        {w.name.replace(/\.(onnx|tar)$/i, "")}
                      </span>
                      <span className="text-muted-foreground tabular-nums">{mb(w.bytes)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-muted-foreground flex-1">{t("engine.toolsTotal", { size: mb(warmBytes) })}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={releasing || !!status?.toolsBusy}
                    onClick={() => {
                      setReleasing(true);
                      void api
                        .releaseTools()
                        .catch(() => {})
                        .finally(() => {
                          setReleasing(false);
                          refresh();
                        });
                    }}
                  >
                    {t("engine.release")}
                  </Button>
                </div>
              </>
            )}
          </section>
        </>
      ) : (
        <section className="flex gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-800 dark:text-sky-200">
          <Cloud className="mt-0.5 size-4 shrink-0" />
          <p>{t("engine.cloudNote")}</p>
        </section>
      )}
    </div>
  );
}
