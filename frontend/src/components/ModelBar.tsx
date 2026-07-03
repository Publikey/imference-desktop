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
  // a pick is applied: local just records the selection (App's Download button
  // fetches weights); cloud records the code instantly.
  mode: Mode;
  // Whole settings object — the card reads cloudModel from it.
  settings: AppSettings | null;
  // Called with refetched settings after a cloud switch.
  onModelSwitched: (next: AppSettings) => void;
  // Local selection is App-owned (decoupled from the download): the pending pick
  // and the download state/progress are passed in.
  pendingLocalModel: ModelInfo | null;
  onSelectLocal: (m: ModelInfo) => void;
  downloading: boolean;
  progress: InstallProgress | null;
};

// ModelBar — the single model selector for the whole app. Just the mode icon +
// a thumbnail-rich dropdown (the Local/Cloud toggle sits right above, so a text
// label is redundant). Catalog is mode-aware:
//   • local mode → only locally-runnable models; picking one records the choice
//     (App's primary button downloads ~6–7 GB of weights on demand).
//   • cloud mode → the full catalog; picking one is instant.
export function ModelBar({
  mode,
  settings,
  onModelSwitched,
  pendingLocalModel,
  onSelectLocal,
  downloading,
  progress,
}: Props) {
  const [localModels, setLocalModels] = useState<ModelInfo[]>([]);
  const [cloudModels, setCloudModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
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

  const isCloud = mode === "cloud";
  const models = isCloud ? cloudModels : localModels;
  const activeCode = isCloud
    ? settings?.cloudModel || null
    : pendingLocalModel?.modelCode ?? null;
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

      // Local: just record the selection — the Download button fetches weights.
      onSelectLocal(target);
    },
    [activeCode, busy, isCloud, models, onModelSwitched, onSelectLocal]
  );

  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-[10px] text-white shadow-sm",
            isCloud ? "bg-gradient-to-br from-sky-400 to-blue-600" : "brand-surface"
          )}
          title={isCloud ? "Cloud model" : "Local model"}
        >
          {isCloud ? <Cloud className="size-[18px]" /> : <Cpu className="size-[18px]" />}
        </span>

        {listError ? (
          <span className="text-destructive flex-1 text-xs">Catalog unavailable</span>
        ) : loading ? (
          <span className="text-muted-foreground inline-flex flex-1 items-center gap-1.5 text-xs">
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
        <p className="text-destructive mt-2 text-xs">{progress.error}</p>
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
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        type="button"
        disabled={disabled || models.length === 0}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "group flex h-10 w-full items-center gap-2.5 rounded-xl border px-2.5 text-left text-sm shadow-sm transition",
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
                {isCloud && m.cost > 0 && (
                  <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums" title="credits per run">
                    {m.cost} cr
                  </span>
                )}
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
