import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ExternalModelWarning } from "@/components/ExternalModelWarning";
import { Section } from "@/components/ds";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ModelPickerDialog, ModelThumb } from "@/components/ModelPickerDialog";
import type { AppSettings, ModelInfo } from "@/lib/types";
import { isEditModel } from "@/lib/tools";
import { rememberModel, useRecentModels } from "@/lib/recent-models";

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
  // is passed in; download/readiness state now lives in the LocalReadinessCard.
  pendingLocalModel: ModelInfo | null;
  onSelectLocal: (m: ModelInfo) => void;
  // Local model codes whose weights are already on disk, so the picker can say
  // which ones load instantly vs. which still need downloading.
  cachedCodes: Set<string>;
  // A download in flight keeps the picker busy (no mid-download switches).
  downloading: boolean;
  // Custom user checkpoints: open the add flow (native picker + backend
  // dialog), activate a registered one, or drop one from the registry.
  onAddCustom: () => void;
  onSelectCustom: (m: ModelInfo) => Promise<void>;
  onRemoveCustom: (m: ModelInfo) => void;
  // Picker open state is controlled by App so the command palette (and later
  // keyboard shortcuts) can open it too, not just the trigger button.
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  // Local mode: the model the engine actually holds (settings.localModel), so
  // the card can say whether the selection is loaded, and load it on demand.
  engineModel?: ModelInfo | null;
  engineState?: string;
  selectionCached?: boolean;
  onLoadNow?: () => void;
  /** Shown under the model, in the same card (the cloud payment line). */
  footer?: ReactNode;
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
  onAddCustom,
  onSelectCustom,
  onRemoveCustom,
  pickerOpen,
  onPickerOpenChange,
  engineModel,
  engineState,
  selectionCached,
  onLoadNow,
  footer,
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
  const selected =
    allModels.find((m) => m.modelCode === activeCode) ?? (!isCloud ? pendingLocalModel ?? null : null);
  // Selected vs loaded: picking a local model only selects it (it loads on
  // Generate, or with "Load now"); say which one the engine holds.
  const loadedHere = !isCloud && !!selected && engineModel?.modelCode === selected.modelCode;
  // A local download must not block the CLOUD picker — switching mode should let
  // you pick a cloud model even while a local model is still downloading.
  const busy = switching || (downloading && !isCloud);

  // Whatever path selected it (this card, the palette, the welcome tour), the
  // active model joins the recents.
  useEffect(() => {
    if (activeCode) rememberModel(mode, activeCode);
  }, [mode, activeCode]);
  const recentCodes = useRecentModels(mode);
  // The way back: the last few others, as one-click chips under the card.
  const quick = recentCodes
    .filter((c) => c !== activeCode)
    .map((c) => allModels.find((m) => m.modelCode === c && !isEditModel(m)))
    .filter((m): m is ModelInfo => !!m)
    .slice(0, 3);

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
    // No section title: the banner itself says "Cloud model" / "Local model".
    <Section className="p-2 [&>*:not(:first-child)]:mx-2 [&>*:last-child]:mb-1.5">
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
          <Skeleton className="h-28 flex-1 rounded-xl" />
        ) : (
          // The chosen model as a banner: its cover image fills the button, a
          // veil on the left keeps the label and name readable over any art.
          <button
            type="button"
            disabled={busy}
            onClick={() => onPickerOpenChange(true)}
            title={isCloud ? t("modelBar.cloudHelp") : t("modelBar.localHelp")}
            className="model-banner group relative flex h-28 min-w-0 flex-1 items-end overflow-hidden rounded-xl text-left disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ModelThumb
              m={selected}
              isCloud={isCloud}
              className="absolute inset-0 size-full object-[center_30%] transition-transform duration-500 ease-[var(--im-ease-out)] group-hover:scale-[1.04]"
              iconClassName="absolute right-6 size-10 opacity-40"
            />
            <span aria-hidden className="model-banner-veil absolute inset-0" />
            <span className="relative flex min-w-0 flex-1 flex-col gap-0.5 p-3 pr-2">
              <span className="text-2xs font-medium text-white/75">
                {isCloud ? t("modelBar.cloudModel") : t("modelBar.localModel")}
              </span>
              <span className="font-display truncate text-lg font-semibold leading-tight text-white">
                {selected?.name ?? (allModels.length ? t("modelBar.selectModel") : t("modelBar.noModels"))}
              </span>
            </span>
            <span className="relative m-3 inline-flex shrink-0 items-center gap-1 rounded-full bg-black/45 px-2.5 py-1 text-2xs font-medium text-white backdrop-blur transition-colors group-hover:bg-black/60">
              {busy ? <Loader2 className="size-3 animate-spin" /> : <ChevronDown className="size-3" />}
              {t("modelBar.change")}
            </span>
          </button>
        )}
      </div>

      {!loading && !listError && quick.length > 0 && (
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <span className="text-subtle shrink-0 text-2xs">{t("modelBar.recent")}</span>
          <div className="flex min-w-0 gap-1 overflow-hidden">
            {quick.map((m) => (
              <button
                key={m.modelCode}
                type="button"
                disabled={busy}
                onClick={() => void pick(m.modelCode)}
                title={t("modelBar.switchTo", { name: m.name })}
                className="ds-chip-btn min-w-0 max-w-[9rem] shrink disabled:opacity-50"
              >
                <span className="truncate">{m.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {isCloud && !loading && !listError && <ExternalModelWarning model={selected} className="mt-2" />}

      {!isCloud && selected && !loading && !listError && (
        downloading || engineState === "starting" ? (
          // A model is being loaded into the engine (a swap, a Load now…).
          <p className="text-primary mt-2 flex items-center gap-1.5 text-2xs">
            <Loader2 className="size-3 animate-spin" />
            {t("modelBar.loading")}
          </p>
        ) : loadedHere ? (
          <p className="mt-2 flex items-center gap-1.5 text-2xs text-success">
            <span className="size-1.5 rounded-full bg-success" />
            {engineState === "ready" ? t("modelBar.loaded") : t("modelBar.loadedWhenStarted")}
          </p>
        ) : (
          <div className="ds-callout ds-callout-warning mt-2 flex items-center gap-2 px-2.5 py-1.5 text-2xs">
            <span className="min-w-0 flex-1">
              {engineModel
                ? t("modelBar.notLoadedHolds", { name: engineModel.name || engineModel.modelCode })
                : t("modelBar.notLoaded")}
              {!selectionCached && <> {t("modelBar.downloadBelow")}</>}
            </span>
            {selectionCached && onLoadNow && (
              <button
                type="button"
                disabled={busy || downloading}
                onClick={onLoadNow}
                className="shrink-0 rounded-md border border-warning/40 px-2 py-0.5 font-medium hover:bg-warning/15 disabled:opacity-50"
              >
                {t("modelBar.loadNow")}
              </button>
            )}
          </div>
        )
      )}

      {/* Download progress / components state moved to the LocalReadinessCard —
          only the custom-activation error still belongs to the selector. */}
      {customError && mode === "local" && (
        <p className="text-destructive mt-2 text-xs">{customError}</p>
      )}

      {footer && <div className="mt-3 border-t pt-3">{footer}</div>}

      <ModelPickerDialog
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        mode={mode}
        paymentMode={settings?.paymentMode === "x402" ? "x402" : "bearer"}
        // Edit models (model_type image-edit) are picked in Edit > Edit with
        // instructions, not here: they cannot generate from a prompt (the card
        // still shows one when it is the engine's model).
        catalog={(isCloud ? cloudModels : localModels).filter((m) => !isEditModel(m))}
        customModels={customModels}
        activeCode={activeCode}
        recentCodes={recentCodes}
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
    </Section>
  );
}
