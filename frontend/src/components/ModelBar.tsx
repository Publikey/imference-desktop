import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Download, Loader2, RefreshCw, X } from "lucide-react";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ProgressBar } from "@/components/ui/progress";
import { ModelPickerDialog, ModelThumb } from "@/components/ModelPickerDialog";
import type {
  AppSettings,
  ComponentsProgress,
  ComponentsReadiness,
  InstallProgress,
  ModelInfo,
} from "@/lib/types";

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
  // Local model codes whose weights are already on disk, so the picker can say
  // which ones load instantly vs. which still need downloading.
  cachedCodes: Set<string>;
  downloading: boolean;
  // True when the activation in flight is loading cached weights rather than
  // downloading them — there's nothing to abort.
  loadingCached: boolean;
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
  // Base-components state (App-owned). A transformer-only model (Z-Image /
  // FLUX / Chroma / Qwen-Image / Krea 2) needs a multi-GB shared base repo;
  // when it's missing, Generate is gated and the download button below the
  // model name is the explicit way to fetch it (with progress).
  componentsReadiness: ComponentsReadiness | null;
  componentsProgress: ComponentsProgress | null;
  componentsDownloading: boolean;
  // True while the readiness check itself runs (manifest + size probes take a
  // couple of seconds) — shown so the verdict doesn't just pop in late.
  componentsChecking: boolean;
  componentsError: string | null;
  onDownloadComponents: () => void;
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
  cachedCodes,
  downloading,
  loadingCached,
  progress,
  onCancelDownload,
  onAddCustom,
  onSelectCustom,
  onRemoveCustom,
  pickerOpen,
  onPickerOpenChange,
  componentsReadiness,
  componentsProgress,
  componentsDownloading,
  componentsChecking,
  componentsError,
  onDownloadComponents,
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

      {/* Base-components row — right under the model name, local mode only.
          Ordered: an active checkpoint download wins the slot; then the
          components download in flight; then its error; then the call-to-action
          when the readiness check found missing files. */}
      {mode === "local" && !downloading && componentsDownloading && componentsProgress ? (
        <ComponentsRow p={componentsProgress} />
      ) : mode === "local" && !downloading && componentsChecking ? (
        <div className="text-muted-foreground mt-2 flex items-center gap-1.5 pl-9 text-[11px]">
          <Loader2 className="size-3 shrink-0 animate-spin opacity-60" />
          {t("modelBar.componentsChecking")}
        </div>
      ) : mode === "local" && !downloading && componentsError ? (
        <div className="mt-2 flex items-center gap-2 pl-9 text-xs">
          <AlertTriangle className="text-destructive size-3 shrink-0" />
          <span className="text-destructive min-w-0 flex-1 truncate" title={componentsError}>
            {componentsError}
          </span>
          <button
            type="button"
            onClick={onDownloadComponents}
            className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 font-medium transition-colors"
          >
            <RefreshCw className="size-3" /> {t("common.retry")}
          </button>
        </div>
      ) : mode === "local" &&
        !downloading &&
        componentsReadiness &&
        componentsReadiness.hasManifest &&
        !componentsReadiness.ready ? (
        <div className="mt-2 flex items-center justify-between gap-2 pl-9 text-xs">
          <span
            className="text-muted-foreground min-w-0 flex-1 truncate"
            title={t("modelBar.componentsMissingTitle", {
              size: humanBytes(componentsReadiness.missingBytes),
              files: componentsReadiness.missingFiles,
              repo: componentsReadiness.baseRepo,
            })}
          >
            {t("modelBar.componentsMissing", {
              size: humanBytes(componentsReadiness.missingBytes),
            })}
          </span>
          <button
            type="button"
            onClick={onDownloadComponents}
            className="border-primary/40 text-primary hover:bg-primary/10 inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium transition-colors"
          >
            <Download className="size-3" />
            {t("modelBar.downloadComponents", {
              size: humanBytes(componentsReadiness.missingBytes),
            })}
          </button>
        </div>
      ) : null}

      {downloading && progress ? (
        <DownloadProgress p={progress} onCancel={onCancelDownload} cancellable={!loadingCached} />
      ) : customError && mode === "local" ? (
        <p className="text-destructive mt-2 text-xs">{customError}</p>
      ) : progress?.error && mode === "local" ? (
        // Prose we author (e.g. out of disk) ships a key; raw Go/network errors
        // don't and stay in English, as everywhere else in the app.
        <p className="text-destructive mt-2 text-xs">
          {progress.messageKey
            ? t(progress.messageKey, { ...progress.messageArgs, defaultValue: progress.error })
            : progress.error}
        </p>
      ) : null}

      <ModelPickerDialog
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        mode={mode}
        paymentMode={settings?.paymentMode === "x402" ? "x402" : "bearer"}
        catalog={isCloud ? cloudModels : localModels}
        customModels={customModels}
        activeCode={activeCode}
        cachedCodes={cachedCodes}
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

// One-line progress for the base-components pull: current file + overall %.
function ComponentsRow({ p }: { p: ComponentsProgress }) {
  const { t } = useTranslation();
  const caption = t("modelBar.componentsDownloading", {
    index: p.fileIndex,
    total: p.totalFiles,
    file: p.file.split("/").pop() ?? p.file,
  });
  return (
    <div className="mt-2.5 space-y-1.5 pl-9">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5">
          <Download className="text-primary size-3 shrink-0 animate-pulse" />
          <span className="truncate" title={caption}>
            {caption}
          </span>
        </span>
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {p.totalBytes > 0
            ? `${humanBytes(p.doneBytes)} / ${humanBytes(p.totalBytes)}`
            : humanBytes(p.doneBytes)}
        </span>
      </div>
      <ProgressBar percent={p.totalBytes > 0 ? p.percent : null} />
    </div>
  );
}

// Local byte formatter (same shape as StorageSection's — kept local, the
// codebase habit for tiny helpers).
function humanBytes(n: number): string {
  if (!n || n < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function DownloadProgress({
  p,
  onCancel,
  cancellable,
}: {
  p: InstallProgress;
  onCancel: () => void;
  cancellable: boolean;
}) {
  const { t } = useTranslation();
  // The Go side sends an i18n key plus already-formatted values (byte sizes read
  // the same in every locale); p.message is the English fallback for a key this
  // build doesn't know yet.
  const text = p.messageKey
    ? t(p.messageKey, { ...p.messageArgs, defaultValue: p.message })
    : p.message;
  return (
    <div className="mt-2.5 space-y-1.5 pl-9">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5">
          <Download className="text-primary size-3 shrink-0 animate-pulse" />
          <span className="truncate" title={text}>
            {text || t("modelBar.working")}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {p.percentEstimate > 0 && (
            <span className="text-muted-foreground tabular-nums">{p.percentEstimate}%</span>
          )}
          {/* Loading cached weights has no fetch to abort — the engine restart
              runs to completion either way, so don't offer a dead Cancel. */}
          {cancellable && (
          <button
            type="button"
            onClick={onCancel}
            className="text-muted-foreground/70 hover:text-destructive inline-flex items-center gap-1 rounded font-medium transition-colors"
            title={t("common.cancel")}
          >
            <X className="size-3" />
            {t("common.cancel")}
          </button>
          )}
        </div>
      </div>
      <ProgressBar percent={p.percentEstimate > 0 ? p.percentEstimate : null} />
    </div>
  );
}
