import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Download, Loader2, RefreshCw, X } from "lucide-react";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ProgressBar } from "@/components/ui/progress";
import { ModelPickerDialog, ModelThumb } from "@/components/ModelPickerDialog";
import type { AppSettings, InstallProgress, ModelInfo } from "@/lib/types";

type Mode = "local" | "cloud";

type Props = {
  // The active generation mode. Drives which catalog the picker shows and how
  // a pick is applied: local just records the selection (App's Download button
  // fetches weights); cloud records the code instantly.
  mode: Mode;
  // Whole settings object — the card reads cloudModel + customModels from it.
  settings: AppSettings | null;
  // Called with refetched settings after a cloud switch.
  onModelSwitched: (next: AppSettings) => void;
  // Local selection is App-owned (decoupled from the download): the pending pick
  // and the download state/progress are passed in.
  pendingLocalModel: ModelInfo | null;
  onSelectLocal: (m: ModelInfo) => void;
  downloading: boolean;
  progress: InstallProgress | null;
  // Abort an in-flight local download.
  onCancelDownload: () => void;
  // Custom user checkpoints: open the add flow (native picker + backend
  // dialog), activate a registered one, or drop one from the registry.
  onAddCustom: () => void;
  onSelectCustom: (m: ModelInfo) => Promise<void>;
  onRemoveCustom: (m: ModelInfo) => void;
  // Picker open state is controlled by App so the command palette (and later
  // keyboard shortcuts) can open it too, not just the trigger button.
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
};

// ModelBar — the single model selector for the whole app. Shows the active
// model as a compact trigger; clicking opens the ModelPickerDialog (cards
// grouped by type, searchable/filterable). Catalog is mode-aware:
//   • local mode → locally-runnable catalog + a "My models" tab for the user's
//     own checkpoints; picking a catalog model records the choice (App's primary
//     button downloads weights on demand).
//   • cloud mode → the full catalog; picking one is instant.
export function ModelBar({
  mode,
  settings,
  onModelSwitched,
  pendingLocalModel,
  onSelectLocal,
  downloading,
  progress,
  onCancelDownload,
  onAddCustom,
  onSelectCustom,
  onRemoveCustom,
  pickerOpen,
  onPickerOpenChange,
}: Props) {
  const { t } = useTranslation();
  const [localModels, setLocalModels] = useState<ModelInfo[]>([]);
  const [cloudModels, setCloudModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false); // cloud quick-switch
  const [customError, setCustomError] = useState<string | null>(null); // custom activation

  // Load both catalogs — extracted so the error state can offer a Retry.
  const loadCatalogs = useCallback(() => {
    let alive = true;
    setLoading(true);
    setListError(null);
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

  useEffect(() => loadCatalogs(), [loadCatalogs]);

  const isCloud = mode === "cloud";
  const customModels = settings?.customModels ?? [];
  // For lookups on pick: local mode resolves both the user's checkpoints and the
  // catalog; cloud mode is catalog-only.
  const allModels = isCloud ? cloudModels : [...customModels, ...localModels];
  const activeCode = isCloud
    ? settings?.cloudModel || null
    : pendingLocalModel?.modelCode ?? null;
  const selected = allModels.find((m) => m.modelCode === activeCode) ?? null;
  // A local download must not block the CLOUD picker — switching mode should let
  // you pick a cloud model even while a local model is still downloading.
  const busy = switching || (downloading && !isCloud);

  const pick = useCallback(
    async (code: string) => {
      if (code === activeCode || busy) return;
      const target = allModels.find((m) => m.modelCode === code);
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

      // Custom checkpoint: activate immediately (no download — file is local).
      if (target.localPath) {
        setSwitching(true);
        setCustomError(null);
        try {
          await onSelectCustom(target);
        } catch (e) {
          setCustomError(e instanceof Error ? e.message : String(e));
        } finally {
          setSwitching(false);
        }
        return;
      }

      // Local: just record the selection — the Download button fetches weights.
      onSelectLocal(target);
    },
    [activeCode, busy, isCloud, allModels, onModelSwitched, onSelectLocal, onSelectCustom]
  );

  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <div className="flex items-center">
        {listError ? (
          <div className="flex h-10 flex-1 items-center gap-2">
            <AlertTriangle className="text-destructive size-4 shrink-0" />
            <span className="text-destructive min-w-0 flex-1 truncate text-xs" title={listError}>
              {t("modelBar.catalogUnavailable")}
            </span>
            <button
              type="button"
              onClick={loadCatalogs}
              className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors"
            >
              <RefreshCw className="size-3" /> {t("common.refresh")}
            </button>
          </div>
        ) : loading ? (
          // Fixed-height skeleton matching the resolved button, so the card
          // doesn't reflow when the catalog arrives.
          <div className="flex h-10 flex-1 items-center gap-2.5 rounded-xl border px-2.5">
            <Skeleton className="size-7 rounded-lg" />
            <Skeleton className="h-3.5 w-28" />
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => onPickerOpenChange(true)}
            title={isCloud ? t("modelBar.cloudModel") : t("modelBar.localModel")}
            className={cn(
              "group flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl border px-2.5 text-left text-sm shadow-sm transition",
              "bg-background/70 hover:border-primary/40 hover:bg-background",
              "disabled:cursor-not-allowed disabled:opacity-60"
            )}
          >
            <ModelThumb m={selected} isCloud={isCloud} className="size-7 rounded-lg" iconClassName="size-3.5" />
            <span className="min-w-0 flex-1 truncate font-medium">
              {selected?.name ?? (allModels.length ? t("modelBar.selectModel") : t("modelBar.noModels"))}
            </span>
            {busy && <Loader2 className="size-4 shrink-0 animate-spin opacity-60" />}
          </button>
        )}
      </div>

      {downloading && progress ? (
        <DownloadProgress p={progress} onCancel={onCancelDownload} />
      ) : customError && mode === "local" ? (
        <p className="text-destructive mt-2 text-xs">{customError}</p>
      ) : progress?.error && mode === "local" ? (
        <p className="text-destructive mt-2 text-xs">{progress.error}</p>
      ) : null}

      <ModelPickerDialog
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        mode={mode}
        paymentMode={settings?.paymentMode === "x402" ? "x402" : "bearer"}
        catalog={isCloud ? cloudModels : localModels}
        customModels={customModels}
        activeCode={activeCode}
        busy={busy}
        onPick={(m) => {
          onPickerOpenChange(false);
          void pick(m.modelCode);
        }}
        onAddCustom={() => {
          onPickerOpenChange(false); // hand off to the native picker + CustomModelDialog
          onAddCustom();
        }}
        onRemoveCustom={onRemoveCustom}
      />
    </section>
  );
}

function DownloadProgress({ p, onCancel }: { p: InstallProgress; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2.5 space-y-1.5 pl-9">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5">
          <Download className="text-primary size-3 shrink-0 animate-pulse" />
          <span className="truncate" title={p.message}>
            {p.message || t("modelBar.working")}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {p.percentEstimate > 0 && (
            <span className="text-muted-foreground tabular-nums">{p.percentEstimate}%</span>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground/70 hover:text-destructive inline-flex items-center gap-1 rounded font-medium transition-colors"
            title={t("common.cancel")}
          >
            <X className="size-3" />
            {t("common.cancel")}
          </button>
        </div>
      </div>
      <ProgressBar percent={p.percentEstimate > 0 ? p.percentEstimate : null} />
    </div>
  );
}
