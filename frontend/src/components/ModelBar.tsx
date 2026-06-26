import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronsUpDown,
  Cloud,
  Cpu,
  Download,
  Loader2,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import type { AppSettings, InstallProgress, ModelInfo } from "@/lib/types";

type Mode = "local" | "cloud";

type Props = {
  // The active generation mode. Drives which catalog the selector shows and how
  // a pick is applied: local downloads weights; cloud just records the code.
  mode: Mode;
  // Whole settings object — the card reads localModel / cloudModel from it.
  settings: AppSettings | null;
  // Called with refetched settings after a switch, so App's generation params
  // (steps/cfg/resolution from the chosen model) stay in sync for both modes.
  onModelSwitched: (next: AppSettings) => void;
};

// ModelBar — the single model selector for the whole app, lifted out of the
// Settings dialog and into the form. It stays mounted for the app's lifetime,
// so a local model download keeps streaming progress here in the background
// even while the user switches to Cloud and generates (cloud uses a separate
// HTTP client and is never blocked by it). The catalog is mode-aware:
//   • local mode → only locally-runnable models; picking one downloads ~6–7 GB
//     of weights and restarts the sidecar (so local is briefly unavailable).
//   • cloud mode → the full catalog (incl. cloud-only Flux/Veo/…); picking one
//     is instant — it just records the model code for the next request.
export function ModelBar({ mode, settings, onModelSwitched }: Props) {
  const [localModels, setLocalModels] = useState<ModelInfo[]>([]);
  const [cloudModels, setCloudModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [downloading, setDownloading] = useState(false); // local weights fetch
  const [switching, setSwitching] = useState(false); // cloud quick-switch

  // Load both catalogs once.
  useEffect(() => {
    let alive = true;
    Promise.all([api.listLocalModels(), api.listCloudModels()])
      .then(([local, cloud]) => {
        if (!alive) return;
        setLocalModels(local);
        setCloudModels(cloud);
        setListError(null);
      })
      .catch((e) => alive && setListError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // Background progress subscription for local downloads — persists for the
  // card's lifetime, so progress survives a mode switch to Cloud.
  useEffect(() => {
    return api.onModelProgress((p) => {
      setProgress(p);
      if (p.done || p.phase === "done" || p.phase === "error") {
        setDownloading(false);
        if (p.phase === "done") void api.getSettings().then(onModelSwitched);
      } else {
        setDownloading(true);
      }
    });
  }, [onModelSwitched]);

  const isCloud = mode === "cloud";
  const models = isCloud ? cloudModels : localModels;
  const activeCode = isCloud
    ? settings?.cloudModel || null
    : settings?.localModel?.modelCode ?? null;
  const active = models.find((m) => m.modelCode === activeCode) ?? null;
  const busy = downloading || switching;

  const pick = useCallback(
    async (code: string) => {
      if (code === activeCode || busy) return;
      const target = models.find((m) => m.modelCode === code);
      if (!target) return;

      if (isCloud) {
        setSwitching(true);
        try {
          await api.selectCloudModel(code);
          onModelSwitched(await api.getSettings());
        } catch (e) {
          setListError(e instanceof Error ? e.message : String(e));
        } finally {
          setSwitching(false);
        }
        return;
      }

      // Local: kick off the background weights download.
      setDownloading(true);
      setProgress({ phase: "model", message: `Preparing ${target.name}`, percentEstimate: 0, done: false });
      try {
        await api.selectLocalModel(code);
      } catch (e) {
        setDownloading(false);
        setProgress({
          phase: "error",
          message: "",
          percentEstimate: 0,
          done: true,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [activeCode, busy, isCloud, models, onModelSwitched]
  );

  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-[9px] text-white shadow-sm",
              isCloud
                ? "bg-gradient-to-br from-sky-400 to-blue-600"
                : "brand-surface"
            )}
          >
            {isCloud ? <Cloud className="size-4" /> : <Cpu className="size-4" />}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold leading-tight">
              {isCloud ? "Cloud model" : "Local model"}
            </span>
            <span className="text-muted-foreground/80 text-[11px] leading-tight">
              {active
                ? `${active.stepsDefault} steps · cfg ${active.cfgDefault}${
                    active.schedulerDefault ? ` · ${active.schedulerDefault}` : ""
                  }`
                : isCloud
                  ? "Runs on imference.com"
                  : "Runs on your GPU"}
            </span>
          </div>
        </div>

        {listError ? (
          <span className="text-destructive text-xs">Catalog unavailable</span>
        ) : loading ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </span>
        ) : (
          <ModelSelect
            models={models}
            value={activeCode}
            disabled={busy}
            isCloud={isCloud}
            onChange={pick}
          />
        )}
      </div>

      {downloading && progress ? (
        <DownloadProgress p={progress} />
      ) : progress?.error && mode === "local" ? (
        <p className="text-destructive mt-2 pl-9 text-xs">{progress.error}</p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ModelSelect — a custom, thumbnail-rich dropdown (the catalog gives every
// model a preview image). Replaces the native <select> for a far nicer look.
// ---------------------------------------------------------------------------

function ModelSelect({
  models,
  value,
  disabled,
  isCloud,
  onChange,
}: {
  models: ModelInfo[];
  value: string | null;
  disabled: boolean;
  isCloud: boolean;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const selected = models.find((m) => m.modelCode === value) ?? null;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled || models.length === 0}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "group flex h-10 w-[15rem] items-center gap-2.5 rounded-xl border px-2.5 text-left text-sm shadow-sm transition",
          "bg-background/70 hover:border-primary/40 hover:bg-background",
          "disabled:cursor-not-allowed disabled:opacity-60",
          open && "border-primary/50 ring-primary/15 ring-2"
        )}
      >
        <Thumb m={selected} isCloud={isCloud} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {selected?.name ?? (models.length ? "Select a model" : "No models")}
        </span>
        {disabled ? (
          <Loader2 className="size-4 shrink-0 animate-spin opacity-60" />
        ) : (
          <ChevronsUpDown className="size-4 shrink-0 opacity-40 transition group-hover:opacity-70" />
        )}
      </button>

      {open && (
        <div className="bg-popover text-popover-foreground animate-in fade-in zoom-in-95 absolute right-0 z-50 mt-2 max-h-[22rem] w-[21rem] origin-top-right overflow-y-auto rounded-xl border p-1.5 shadow-xl">
          {models.map((m) => {
            const isActive = m.modelCode === value;
            return (
              <button
                key={m.modelCode}
                type="button"
                onClick={() => {
                  onChange(m.modelCode);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition",
                  isActive ? "bg-accent" : "hover:bg-accent/60"
                )}
              >
                <Thumb m={m} isCloud={isCloud} large />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{m.name}</span>
                    {!m.modelUrl && (
                      <span className="bg-muted text-muted-foreground rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
                        cloud
                      </span>
                    )}
                  </div>
                  {m.shortDescription && (
                    <div className="text-muted-foreground truncate text-[11px]">
                      {m.shortDescription}
                    </div>
                  )}
                </div>
                {isActive && <Check className="text-primary size-4 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Thumb({
  m,
  isCloud,
  large,
}: {
  m: ModelInfo | null;
  isCloud: boolean;
  large?: boolean;
}) {
  const size = large ? "size-10" : "size-7";
  if (m?.image) {
    return (
      <img
        src={m.image}
        alt=""
        className={cn(size, "shrink-0 rounded-lg object-cover")}
        onError={(e) => (e.currentTarget.style.display = "none")}
      />
    );
  }
  return (
    <span
      className={cn(
        size,
        "flex shrink-0 items-center justify-center rounded-lg text-white",
        isCloud ? "bg-gradient-to-br from-sky-400 to-blue-600" : "brand-surface"
      )}
    >
      <Sparkles className={large ? "size-5" : "size-3.5"} />
    </span>
  );
}

function DownloadProgress({ p }: { p: InstallProgress }) {
  return (
    <div className="mt-2.5 space-y-1.5 pl-9">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5">
          <Download className="text-primary size-3 shrink-0 animate-pulse" />
          <span className="truncate" title={p.message}>
            {p.message || "Working…"}
          </span>
        </span>
        {p.percentEstimate > 0 && (
          <span className="text-muted-foreground shrink-0 tabular-nums">{p.percentEstimate}%</span>
        )}
      </div>
      <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            p.percentEstimate > 0 ? "btn-brand" : "bg-primary/50 w-full animate-pulse"
          )}
          style={p.percentEstimate > 0 ? { width: `${p.percentEstimate}%` } : undefined}
        />
      </div>
    </div>
  );
}
