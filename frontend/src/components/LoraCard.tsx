import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/wails-bridge";
import type { AppSettings, LoraEntry, LoraRef } from "@/lib/types";

/** Backends whose local engine applies user LoRAs. Mirrors the Go gate
 *  (internal/loras.BackendSupports) — flip both when a family is enabled. */
export const LORA_BACKENDS = new Set(["sdxl"]);

/** Most LoRAs stacked on one generation (the Go side enforces the same cap). */
export const MAX_ACTIVE_LORAS = 4;

const DEFAULT_WEIGHT = 0.8;

/** A library entry can go on a model of this backend unless it was positively
 *  identified for another family (unknown layouts are left for the engine). */
export function loraFitsBackend(entry: LoraEntry, backend: string): boolean {
  return !entry.family || entry.family === backend;
}

// LoRA card inside the composer (local mode, LoRA-capable backends only). Lists
// the library entries that fit the active model; checking one stacks it on the
// next generation with its own weight. Files are referenced in place — removing
// one from the library never touches the file.
export function LoraCard({
  backend,
  library,
  active,
  onActiveChange,
  onSettingsChange,
  onInsertTrigger,
}: {
  backend: string;
  library: LoraEntry[];
  active: LoraRef[];
  onActiveChange: (next: LoraRef[]) => void;
  onSettingsChange: (next: AppSettings) => void;
  /** Adds a trigger word to the prompt (no-op when it's already there). */
  onInsertTrigger: (word: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const fitting = library.filter((l) => loraFitsBackend(l, backend));
  const weightOf = (path: string) => active.find((a) => a.path === path)?.weight;

  const toggle = (entry: LoraEntry, on: boolean) => {
    if (!on) {
      onActiveChange(active.filter((a) => a.path !== entry.path));
    } else if (active.length >= MAX_ACTIVE_LORAS) {
      toast.error(t("lora.tooMany", { max: MAX_ACTIVE_LORAS }));
    } else {
      onActiveChange([...active, { path: entry.path, weight: DEFAULT_WEIGHT }]);
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
      if (entry && !loraFitsBackend(entry, backend)) {
        toast.toast(t("lora.addedOtherFamily", { name: entry.name, family: entry.family }));
      }
    } catch (e) {
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

      {fitting.length === 0 ? (
        <p className="text-muted-foreground/70 text-[11px] leading-snug">{t("lora.hint")}</p>
      ) : (
        <ul className="grid gap-2">
          {fitting.map((entry) => {
            const weight = weightOf(entry.path);
            const on = weight !== undefined;
            const w = weight ?? DEFAULT_WEIGHT;
            return (
              <li key={entry.path} className="group grid gap-1">
                <div className="flex items-center gap-2">
                  <Checkbox checked={on} onCheckedChange={(v) => toggle(entry, v)} />
                  <span className="min-w-0 flex-1 truncate text-xs" title={entry.path}>
                    {entry.name}
                  </span>
                  {on && (
                    <span className="text-muted-foreground text-xs tabular-nums">{w.toFixed(2)}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(entry)}
                    title={t("lora.remove")}
                    className="text-muted-foreground/50 hover:text-foreground opacity-0 group-hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </div>
                {!!entry.triggerWords?.length && (
                  <div className="flex flex-wrap items-center gap-1 pl-6">
                    {entry.triggerWords.map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => onInsertTrigger(w)}
                        title={t("lora.insertTrigger")}
                        className="bg-muted hover:bg-accent rounded px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        {w}
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
                    min={-1}
                    max={2}
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
    </section>
  );
}
