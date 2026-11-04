import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, Loader2, MemoryStick, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import { ENGINE_LABEL } from "@/lib/engines";
import type { EngineStatusInfo, ModelInfo, SidecarStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// EngineDetails — the machine's side of local mode, shown in the header's
// engine popover: the GPU, the generation model the engine holds, and the
// small tool models loaded next to it (with a button to free them).
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

/** The torch device id as people say it ("cuda" → "CUDA"). */
export function deviceLabel(device: string): string {
  const d = device.toLowerCase();
  if (d.startsWith("cuda")) return "CUDA";
  if (d === "mps") return "Apple Metal";
  if (d === "cpu") return "CPU";
  if (d === "xpu") return "Intel XPU";
  if (d.startsWith("privateuseone") || d === "directml") return "DirectML";
  return device;
}

/** The sidecar state as a small status dot + word. */
export function SidecarPill({ sidecar }: { sidecar: SidecarStatus }) {
  const { t } = useTranslation();
  const tone =
    sidecar.state === "ready"
      ? "text-success"
      : sidecar.state === "starting"
        ? "text-warning"
        : sidecar.state === "error"
          ? "text-destructive"
          : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", tone)}>
      {sidecar.state === "starting" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <span className="size-1.5 rounded-full bg-current" />
      )}
      {t(`engine.state.${sidecar.state}`)}
    </span>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <span className="text-muted-foreground mt-0.5 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1 text-xs">
        <p className="ds-sublabel mb-1">{label}</p>
        {children}
      </div>
    </div>
  );
}

export function EngineDetails({
  sidecar,
  localModel,
  loraCount,
}: {
  sidecar: SidecarStatus;
  localModel: ModelInfo | null | undefined;
  loraCount: number;
}) {
  const { t } = useTranslation();
  const { status, refresh } = useEngineStatus(true, sidecar.state);
  const [releasing, setReleasing] = useState(false);
  const warm = status?.toolsWarm ?? [];
  const warmBytes = warm.reduce((n, w) => n + w.bytes, 0);
  const engineName = localModel?.backendType ? ENGINE_LABEL[localModel.backendType] : undefined;

  return (
    <div className="divide-border/70 divide-y">
      <Row icon={<MemoryStick />} label={t("engine.machine")}>
        <p className="text-sm font-medium">{status?.gpuName || t("engine.noGpu")}</p>
        {!!status?.vramGiB && (
          <p className="text-muted-foreground">{t("engine.vram", { gb: status.vramGiB.toFixed(1) })}</p>
        )}
      </Row>

      <Row icon={<Cpu />} label={t("engine.generation")}>
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">
            {localModel ? localModel.name || localModel.modelCode : t("engine.noModel")}
          </p>
          <SidecarPill sidecar={sidecar} />
        </div>
        <p className="text-muted-foreground">
          {[
            engineName && t("engine.engineName", { engine: engineName }),
            sidecar.state === "ready" && "device" in sidecar && t("engine.device", { device: deviceLabel(sidecar.device) }),
            loraCount > 0 && t("engine.loras", { count: loraCount }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </Row>

      {warm.length > 0 && (
        <Row icon={<Wrench />} label={t("engine.tools")}>
          <ul className="space-y-0.5">
            {warm.map((w) => (
              <li key={w.name} className="flex items-center gap-2">
                <span className="bg-success size-1.5 shrink-0 rounded-full" />
                <span className="min-w-0 flex-1 truncate">{w.name.replace(/\.(onnx|tar)$/i, "")}</span>
                <span className="text-muted-foreground tabular-nums">{mb(w.bytes)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-muted-foreground flex-1">{t("engine.toolsTotal", { size: mb(warmBytes) })}</span>
            {status?.toolsBusy && <Loader2 className="text-muted-foreground size-3.5 animate-spin" />}
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
        </Row>
      )}
    </div>
  );
}
