import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Loader2, Plus, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/wails-bridge";
import type { AppSettings, CatalogLora, LoraEntry, LoraRef } from "@/lib/types";

/** Backends whose local engine applies user LoRAs. Mirrors the Go gate
 *  (internal/loras.BackendSupports) — flip both when a family is enabled. */
export const LORA_BACKENDS = new Set(["sdxl"]);

/** Most LoRAs stacked on one generation (the Go side enforces the same cap). */
export const MAX_ACTIVE_LORAS = 4;

const DEFAULT_WEIGHT = 0.8;
// Slider range for local imports, which carry no catalog bounds.
const LOCAL_WEIGHT_MIN = -1;
const LOCAL_WEIGHT_MAX = 2;

/** A library entry goes on the active model when its architecture fits the
 *  backend (unknown layouts are left for the engine) and, when both sides know
 *  their catalog family (sdxl / pony / illustrious …), the families match.
 *  Mirrors App.validateLoras. */
export function loraFits(entry: LoraEntry, backend: string, familyCode?: string): boolean {
  if (entry.family && entry.family !== backend) return false;
  const families = entry.compatibleFamilyCodes ?? [];
  return !familyCode || families.length === 0 || families.includes(familyCode);
}

/** The weight a newly checked LoRA starts at: its catalog pre-config, else 0.8. */
export function initialWeight(entry: LoraEntry): number {
  return entry.weightDefault ?? DEFAULT_WEIGHT;
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20))} MB`;
}

// LoRA card inside the composer (local mode, LoRA-capable backends only).
// "Catalog": curated LoRAs for the active model, downloaded on demand into the
// app's LoRA folder (SHA256-checked). Library: downloaded + imported LoRAs that
// fit the model; checking one stacks it on the next generation with its own
// weight, starting at (and bounded by) the catalog pre-config when it has one.
// Imported files are referenced in place; removing a downloaded one deletes it.
export function LoraCard({
  backend,
  modelCode,
  familyCode,
  library,
  active,
  onActiveChange,
  onSettingsChange,
  onInsertTrigger,
}: {
  backend: string;
  /** Active local model; the catalog list is refetched when it changes. */
  modelCode: string;
  familyCode?: string;
  library: LoraEntry[];
  active: LoraRef[];
  onActiveChange: (next: LoraRef[]) => void;
  onSettingsChange: (next: AppSettings) => void;
  /** Adds a trigger word to the prompt (no-op when it's already there). */
  onInsertTrigger: (word: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [catalog, setCatalog] = useState<CatalogLora[]>([]);
  // catalog code → download percent while in flight
  const [downloading, setDownloading] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .listCatalogLoras()
      .then((list) => !cancelled && setCatalog(list ?? []))
      .catch(() => !cancelled && setCatalog([])); // offline: the library still works
    return () => {
      cancelled = true;
    };
  }, [modelCode]);

  useEffect(
    () =>
      api.onLoraProgress((p) => {
        if (!p.done) {
          setDownloading((d) => ({ ...d, [p.code]: p.percent }));
          return;
        }
        setDownloading((d) => {
          const { [p.code]: _, ...rest } = d;
          return rest;
        });
        if (p.error) {
          toast.error(t("lora.downloadFailed", { error: p.error }));
        } else {
          void api.getSettings().then(onSettingsChange);
        }
      }),
    [onSettingsChange, t, toast]
  );

  const fitting = library.filter((l) => loraFits(l, backend, familyCode));
  const inLibrary = new Set(library.map((l) => l.catalogCode).filter(Boolean));
  const available = catalog.filter((c) => !inLibrary.has(c.code));
  const weightOf = (path: string) => active.find((a) => a.path === path)?.weight;

  const toggle = (entry: LoraEntry, on: boolean) => {
    if (!on) {
      onActiveChange(active.filter((a) => a.path !== entry.path));
    } else if (active.length >= MAX_ACTIVE_LORAS) {
      toast.error(t("lora.tooMany", { max: MAX_ACTIVE_LORAS }));
    } else {
      onActiveChange([...active, { path: entry.path, weight: initialWeight(entry) }]);
    }
  };

  const setWeight = (path: string, weight: number) =>
    onActiveChange(active.map((a) => (a.path === path ? { ...a, weight } : a)));

  const add = async () => {
    let path = "";
    try {
      path = await api.pickLoraFile();
    } catch {
      return; // picker failure = cancel
    }
    if (!path) return;
    try {
      const next = await api.addLora(path);
      onSettingsChange(next);
      const entry = next.loras?.find((l) => l.path === path);
      if (entry && !loraFits(entry, backend, familyCode)) {
        toast.toast(t("lora.addedOtherFamily", { name: entry.name, family: entry.family }));
      }
    } catch (e) {
      toast.error(String(e));
    }
  };

  const download = async (lora: CatalogLora) => {
    setDownloading((d) => ({ ...d, [lora.code]: 0 }));
    try {
      await api.downloadCatalogLora(lora.code);
    } catch (e) {
      setDownloading((d) => {
        const { [lora.code]: _, ...rest } = d;
        return rest;
      });
      toast.error(String(e));
    }
  };

  const remove = async (entry: LoraEntry) => {
    onActiveChange(active.filter((a) => a.path !== entry.path));
    try {
      onSettingsChange(await api.removeLora(entry.path));
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          {t("lora.title")}
          <span className="text-muted-foreground/50 ml-1.5 normal-case">· {t("lora.optional")}</span>
        </span>
        <button
          type="button"
          onClick={() => void add()}
          className="text-muted-foreground/70 hover:text-foreground inline-flex items-center gap-1 text-[11px]"
        >
          <Plus className="size-3" />
          {t("lora.add")}
        </button>
      </div>

      {fitting.length === 0 && available.length === 0 ? (
        <p className="text-muted-foreground/70 text-[11px] leading-snug">{t("lora.hint")}</p>
      ) : (
        <ul className="grid gap-2">
          {fitting.map((entry) => {
            const weight = weightOf(entry.path);
            const on = weight !== undefined;
            const w = weight ?? initialWeight(entry);
            return (
              <li key={entry.path} className="group grid gap-1">
                <div className="flex items-center gap-2">
                  <Checkbox checked={on} onCheckedChange={(v) => toggle(entry, v)} />
                  {entry.image && <img src={entry.image} alt="" className="size-6 rounded object-cover" />}
                  <span className="min-w-0 flex-1 truncate text-xs" title={entry.path}>
                    {entry.name}
                  </span>
                  {on && (
                    <span className="text-muted-foreground text-xs tabular-nums">{w.toFixed(2)}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(entry)}
                    title={entry.managed ? t("lora.removeDownloaded") : t("lora.remove")}
                    className="text-muted-foreground/50 hover:text-foreground opacity-0 group-hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </div>
                {!!entry.triggerWords?.length && (
                  <div className="flex flex-wrap items-center gap-1 pl-6">
                    {entry.triggerWords.map((word) => (
                      <button
                        key={word}
                        type="button"
                        onClick={() => onInsertTrigger(word)}
                        title={t("lora.insertTrigger")}
                        className="bg-muted hover:bg-accent rounded px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        {word}
                      </button>
                    ))}
                    <span className="text-muted-foreground/60 text-[10px]">
                      {entry.textEncoderTrained ? t("lora.triggerNeeded") : t("lora.triggerOptional")}
                    </span>
                  </div>
                )}
                {on && (
                  <input
                    type="range"
                    min={entry.weightMin ?? LOCAL_WEIGHT_MIN}
                    max={entry.weightMax ?? LOCAL_WEIGHT_MAX}
                    step={0.05}
                    value={w}
                    onChange={(e) => setWeight(entry.path, Number(e.target.value))}
                    className="range w-full"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {available.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <span className="text-muted-foreground/70 text-[10px] font-medium uppercase tracking-wide">
            {t("lora.catalog")}
          </span>
          <ul className="mt-1.5 grid gap-2">
            {available.map((lora) => {
              const pct = downloading[lora.code];
              return (
                <li key={lora.code} className="flex items-center gap-2">
                  {lora.image ? (
                    <img src={lora.image} alt="" className="size-8 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="bg-muted size-8 shrink-0 rounded" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs">{lora.name}</div>
                    <div className="text-muted-foreground/70 truncate text-[10px]" title={lora.mediumDescription}>
                      {lora.shortDescription}
                      {lora.sizeBytes ? ` · ${formatSize(lora.sizeBytes)}` : ""}
                    </div>
                  </div>
                  {pct !== undefined ? (
                    <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] tabular-nums">
                      <Loader2 className="size-3 animate-spin" />
                      {pct}%
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void download(lora)}
                      title={t("lora.download")}
                      className="text-muted-foreground/70 hover:text-foreground inline-flex items-center gap-1 text-[11px]"
                    >
                      <Download className="size-3" />
                      {t("lora.download")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
