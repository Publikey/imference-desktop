import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FileBox, Loader2, PackageOpen, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import type { AppSettings, CatalogLora, CloudLoraRef, LoraEntry, LoraRef } from "@/lib/types";

/** Backends whose local engine applies user LoRAs. Mirrors the Go gate
 *  (internal/loras.BackendSupports) — flip both when a family is enabled. */
export const LORA_BACKENDS = new Set(["sdxl"]);

/** Most LoRAs stacked on one generation (the Go side enforces the same cap). */
export const MAX_ACTIVE_LORAS = 4;

const DEFAULT_WEIGHT = 0.8;
// Slider range for local imports, which carry no catalog bounds.
const LOCAL_WEIGHT_MIN = -1;
const LOCAL_WEIGHT_MAX = 2;

// Catalog categories in display order (lora.category); anything else is "other".
const CATEGORIES = ["style", "character", "concept", "clothing", "pose", "detail", "other"];

/** A library entry goes on the active model when its architecture fits the
 *  backend (unknown layouts are left for the engine) and, when both sides know
 *  their catalog family (sdxl / pony / illustrious …), the families match.
 *  Mirrors App.validateLoras. */
export function loraFits(entry: LoraEntry, backend: string, familyCode?: string): boolean {
  if (entry.family && entry.family !== backend) return false;
  const families = entry.compatibleFamilyCodes ?? [];
  return !familyCode || families.length === 0 || families.includes(familyCode);
}

/** The weight a newly added LoRA starts at: its catalog pre-config, else 0.8. */
export function initialWeight(entry: LoraEntry): number {
  return entry.weightDefault ?? DEFAULT_WEIGHT;
}

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  return bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20))} MB`;
}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _drop, ...rest } = rec;
  return rest;
}

// ---------------------------------------------------------------------------
// Composer cards: the selected LoRAs + an "Add" button that opens the picker.
// ---------------------------------------------------------------------------

// Local mode. The picker offers the curated catalog (downloaded on demand into
// the app's LoRA folder, SHA256-checked, then added) and "My LoRAs" (imported
// files, referenced in place). Selections are library paths.
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
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogLora[]>([]);
  // catalog code → download percent while in flight
  const [downloading, setDownloading] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .listCatalogLoras()
      .then((list) => !cancelled && setCatalog(list ?? []))
      .catch(() => !cancelled && setCatalog([])); // offline: imported LoRAs still work
    return () => {
      cancelled = true;
    };
  }, [modelCode]);

  const fitting = library.filter((l) => loraFits(l, backend, familyCode));
  const byPath = new Map(library.map((l) => [l.path, l]));
  const byCatalogCode = new Map(library.filter((l) => l.catalogCode).map((l) => [l.catalogCode!, l]));
  const isActive = (path: string) => active.some((a) => a.path === path);

  const add = (entry: LoraEntry): boolean => {
    if (isActive(entry.path)) return true;
    if (active.length >= MAX_ACTIVE_LORAS) {
      toast.error(t("lora.tooMany", { max: MAX_ACTIVE_LORAS }));
      return false;
    }
    onActiveChange([...active, { path: entry.path, weight: initialWeight(entry) }]);
    return true;
  };
  const removeActive = (path: string) => onActiveChange(active.filter((a) => a.path !== path));

  // A finished download lands in the library: select it right away (that's
  // why the user clicked it). Settings are re-read to get the new entry.
  useEffect(
    () =>
      api.onLoraProgress((p) => {
        if (!p.done) {
          setDownloading((d) => ({ ...d, [p.code]: p.percent }));
          return;
        }
        setDownloading((d) => withoutKey(d, p.code));
        if (p.error) {
          toast.error(t("lora.downloadFailed", { error: p.error }));
          return;
        }
        void api.getSettings().then((s) => {
          onSettingsChange(s);
          const entry = s.loras?.find((l) => l.catalogCode === p.code);
          if (entry) onActiveChange(active.some((a) => a.path === entry.path)
            ? active
            : active.length >= MAX_ACTIVE_LORAS ? active : [...active, { path: entry.path, weight: initialWeight(entry) }]);
        });
      }),
    [active, onActiveChange, onSettingsChange, t, toast]
  );

  const pickCatalog = async (lora: CatalogLora) => {
    const entry = byCatalogCode.get(lora.code);
    if (entry) {
      if (isActive(entry.path)) removeActive(entry.path);
      else if (add(entry)) setOpen(false);
      return;
    }
    if (downloading[lora.code] !== undefined) return;
    if (active.length >= MAX_ACTIVE_LORAS) {
      toast.error(t("lora.tooMany", { max: MAX_ACTIVE_LORAS }));
      return;
    }
    setDownloading((d) => ({ ...d, [lora.code]: 0 }));
    try {
      await api.downloadCatalogLora(lora.code);
    } catch (e) {
      setDownloading((d) => withoutKey(d, lora.code));
      toast.error(String(e));
    }
  };

  const pickMine = (entry: LoraEntry) => {
    if (isActive(entry.path)) removeActive(entry.path);
    else if (add(entry)) setOpen(false);
  };

  const importFile = async () => {
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

  const removeFromLibrary = async (entry: LoraEntry) => {
    removeActive(entry.path);
    try {
      onSettingsChange(await api.removeLora(entry.path));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const catalogItems: PickerItem[] = catalog.map((lora) => {
    const entry = byCatalogCode.get(lora.code);
    return {
      key: `catalog:${lora.code}`,
      name: lora.name,
      description: lora.shortDescription,
      image: lora.image,
      category: lora.category,
      nsfw: lora.nsfw,
      sizeBytes: lora.sizeBytes,
      downloaded: !!entry,
      active: !!entry && isActive(entry.path),
      progress: downloading[lora.code],
      onPick: () => void pickCatalog(lora),
      onRemove: entry ? () => void removeFromLibrary(entry) : undefined,
      removeTitle: t("lora.removeDownloaded"),
    };
  });
  const mineItems: PickerItem[] = fitting
    .filter((l) => !l.catalogCode)
    .map((entry) => ({
      key: `mine:${entry.path}`,
      name: entry.name,
      description: entry.path,
      custom: true,
      sizeBytes: entry.sizeBytes,
      active: isActive(entry.path),
      onPick: () => pickMine(entry),
      onRemove: () => void removeFromLibrary(entry),
      removeTitle: t("lora.remove"),
    }));

  const rows = active
    .map((a) => {
      const entry = byPath.get(a.path);
      if (!entry || !loraFits(entry, backend, familyCode)) return null;
      return (
        <SelectedLoraRow
          key={a.path}
          name={entry.name}
          image={entry.image}
          weight={a.weight}
          min={entry.weightMin ?? LOCAL_WEIGHT_MIN}
          max={entry.weightMax ?? LOCAL_WEIGHT_MAX}
          triggerWords={entry.triggerWords ?? []}
          triggersNeeded={!!entry.textEncoderTrained}
          onWeight={(w) => onActiveChange(active.map((x) => (x.path === a.path ? { ...x, weight: w } : x)))}
          onRemove={() => removeActive(a.path)}
          onInsertTrigger={onInsertTrigger}
        />
      );
    })
    .filter(Boolean);

  return (
    <>
      <LoraCardShell count={rows.length} onAdd={() => setOpen(true)}>
        {rows}
      </LoraCardShell>
      <LoraPickerDialog
        open={open}
        onOpenChange={setOpen}
        mode="local"
        catalog={catalogItems}
        mine={mineItems}
        onImport={() => void importFile()}
      />
    </>
  );
}

// Cloud mode: the curated LoRAs that go on the selected cloud model; imference
// applies them on its workers, nothing is downloaded. Selections are catalog
// codes; ones the current model doesn't take are dropped.
export function CloudLoraCard({
  modelCode,
  active,
  onActiveChange,
  onInsertTrigger,
}: {
  modelCode: string;
  active: CloudLoraRef[];
  onActiveChange: (next: CloudLoraRef[]) => void;
  onInsertTrigger: (word: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loras, setLoras] = useState<CatalogLora[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listCloudLoras()
      .then((list) => !cancelled && setLoras(list ?? []))
      .catch(() => !cancelled && setLoras([]));
    return () => {
      cancelled = true;
    };
  }, [modelCode]);

  useEffect(() => {
    if (!loras) return;
    const codes = new Set(loras.map((l) => l.code));
    if (active.some((a) => !codes.has(a.code))) onActiveChange(active.filter((a) => codes.has(a.code)));
  }, [loras, active, onActiveChange]);

  // No catalog LoRA for this model: no card at all (nothing to add).
  if (!loras || loras.length === 0) return null;
  const byCode = new Map(loras.map((l) => [l.code, l]));
  const isActive = (code: string) => active.some((a) => a.code === code);

  const toggle = (lora: CatalogLora) => {
    if (isActive(lora.code)) {
      onActiveChange(active.filter((a) => a.code !== lora.code));
    } else if (active.length >= MAX_ACTIVE_LORAS) {
      toast.error(t("lora.tooMany", { max: MAX_ACTIVE_LORAS }));
    } else {
      onActiveChange([...active, { code: lora.code, weight: lora.weightDefault }]);
      setOpen(false);
    }
  };

  const items: PickerItem[] = loras.map((lora) => ({
    key: lora.code,
    name: lora.name,
    description: lora.shortDescription,
    image: lora.image,
    category: lora.category,
    nsfw: lora.nsfw,
    active: isActive(lora.code),
    onPick: () => toggle(lora),
  }));

  const rows = active
    .map((a) => {
      const lora = byCode.get(a.code);
      if (!lora) return null;
      return (
        <SelectedLoraRow
          key={a.code}
          name={lora.name}
          image={lora.image}
          weight={a.weight}
          min={lora.weightMin}
          max={lora.weightMax}
          triggerWords={lora.triggerWords}
          triggersNeeded={lora.textEncoderTrained !== false}
          onWeight={(w) => onActiveChange(active.map((x) => (x.code === a.code ? { ...x, weight: w } : x)))}
          onRemove={() => onActiveChange(active.filter((x) => x.code !== a.code))}
          onInsertTrigger={onInsertTrigger}
        />
      );
    })
    .filter(Boolean);

  return (
    <>
      <LoraCardShell count={rows.length} onAdd={() => setOpen(true)}>
        {rows}
      </LoraCardShell>
      <LoraPickerDialog open={open} onOpenChange={setOpen} mode="cloud" catalog={items} />
    </>
  );
}

function LoraCardShell({
  count,
  onAdd,
  children,
}: {
  count: number;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          {t("lora.title")}
          <span className="text-muted-foreground/50 ml-1.5 normal-case">· {t("lora.optional")}</span>
        </span>
        <button
          type="button"
          onClick={onAdd}
          disabled={count >= MAX_ACTIVE_LORAS}
          className="text-primary hover:bg-primary/10 border-primary/30 inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40"
        >
          <Plus className="size-3" />
          {t("lora.add")}
        </button>
      </div>
      {count === 0 ? (
        <p className="text-muted-foreground/70 mt-2 text-[11px] leading-snug">{t("lora.emptySelected")}</p>
      ) : (
        <ul className="mt-2 grid gap-3">{children}</ul>
      )}
    </section>
  );
}

function SelectedLoraRow({
  name,
  image,
  weight,
  min,
  max,
  triggerWords,
  triggersNeeded,
  onWeight,
  onRemove,
  onInsertTrigger,
}: {
  name: string;
  image?: string;
  weight: number;
  min: number;
  max: number;
  triggerWords: string[];
  triggersNeeded: boolean;
  onWeight: (w: number) => void;
  onRemove: () => void;
  onInsertTrigger: (word: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="grid gap-1">
      <div className="flex items-center gap-2">
        <LoraThumb image={image} className="size-7 rounded" iconClassName="size-3.5" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
          {name}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">{weight.toFixed(2)}</span>
        <button
          type="button"
          onClick={onRemove}
          title={t("lora.unselect")}
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={0.05}
        value={weight}
        onChange={(e) => onWeight(Number(e.target.value))}
        className="range w-full"
      />
      {triggerWords.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {triggerWords.map((word) => (
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
            {triggersNeeded ? t("lora.triggerNeeded") : t("lora.triggerOptional")}
          </span>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Picker dialog — same shape as ModelPickerDialog: tabs (local), search,
// category chips, a grid of cards. Picking toggles a LoRA on the generation.
// ---------------------------------------------------------------------------

type PickerItem = {
  key: string;
  name: string;
  description?: string;
  image?: string;
  category?: string;
  nsfw?: boolean;
  sizeBytes?: number;
  /** Catalog LoRA already on disk (local mode). */
  downloaded?: boolean;
  /** Imported file ("My LoRAs"). */
  custom?: boolean;
  active: boolean;
  /** Download percent while in flight. */
  progress?: number;
  onPick: () => void;
  onRemove?: () => void;
  removeTitle?: string;
};

function matches(item: PickerItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.name} ${item.description ?? ""} ${item.category ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
}

function LoraPickerDialog({
  open,
  onOpenChange,
  mode,
  catalog,
  mine = [],
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "local" | "cloud";
  catalog: PickerItem[];
  mine?: PickerItem[];
  onImport?: () => void;
}) {
  const { t } = useTranslation();
  const isCloud = mode === "cloud";
  const [tab, setTab] = useState<"catalog" | "mine">("catalog");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");

  const source = isCloud || tab === "catalog" ? catalog : mine;
  const presentCategories = useMemo(() => {
    const present = new Set(source.map((i) => i.category || "other"));
    return CATEGORIES.filter((c) => present.has(c));
  }, [source]);

  useEffect(() => {
    if (category !== "all" && !presentCategories.includes(category)) setCategory("all");
  }, [presentCategories, category]);

  const items = source.filter(
    (i) => (category === "all" || (i.category || "other") === category) && matches(i, search)
  );
  const showMine = !isCloud && tab === "mine";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle>{t("loraPicker.title")}</DialogTitle>
          <DialogDescription>{isCloud ? t("loraPicker.cloudDesc") : t("loraPicker.localDesc")}</DialogDescription>

          {!isCloud && (
            <div className="mt-1 flex gap-1">
              {(["catalog", "mine"] as const).map((tabId) => (
                <button
                  key={tabId}
                  type="button"
                  onClick={() => setTab(tabId)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                    tab === tabId
                      ? "border-primary bg-primary/10 text-primary"
                      : "hover:bg-accent border-transparent text-muted-foreground"
                  )}
                >
                  {tabId === "catalog" ? t("loraPicker.catalogTab") : t("loraPicker.mineTab")}
                  {tabId === "mine" && mine.length > 0 && <span className="ml-1.5 opacity-70">{mine.length}</span>}
                </button>
              ))}
            </div>
          )}

          <div className="mt-2 flex flex-col gap-2">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("loraPicker.searchPlaceholder")}
                className="border-input bg-background h-9 w-full rounded-md border pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {presentCategories.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                <Chip active={category === "all"} onClick={() => setCategory("all")}>
                  {t("common.all")}
                </Chip>
                {presentCategories.map((c) => (
                  <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
                    {t(`loraPicker.category.${c}`)}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-y-auto px-5 py-4">
          {showMine && onImport && (
            <button
              type="button"
              onClick={onImport}
              className="border-border/70 hover:border-primary/50 hover:bg-accent/50 mb-4 flex w-full items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-left transition"
            >
              <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
                <Plus className="size-5" />
              </span>
              <div>
                <div className="text-sm font-medium">{t("loraPicker.importFile")}</div>
                <div className="text-muted-foreground text-xs">{t("loraPicker.importHint")}</div>
              </div>
            </button>
          )}

          {items.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-3 py-12 text-center">
              <div className="bg-muted flex size-12 items-center justify-center rounded-2xl">
                <PackageOpen className="size-6 opacity-70" strokeWidth={1.75} />
              </div>
              <p className="text-sm">
                {showMine
                  ? t("loraPicker.emptyMine")
                  : search || category !== "all"
                    ? t("loraPicker.emptyFiltered")
                    : t("loraPicker.empty")}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {items.map((item) => (
                <LoraPickerCard key={item.key} item={item} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LoraPickerCard({ item }: { item: PickerItem }) {
  const { t } = useTranslation();
  const downloading = item.progress !== undefined;
  return (
    <div
      className={cn(
        "group bg-card relative flex flex-col overflow-hidden rounded-xl border text-left transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:shadow-md",
        item.active ? "border-primary ring-primary/20 ring-2" : "hover:border-primary/40"
      )}
    >
      <button
        type="button"
        disabled={downloading}
        onClick={item.onPick}
        className="flex flex-col text-left disabled:cursor-progress"
      >
        <div className="bg-muted relative aspect-square w-full overflow-hidden">
          <LoraThumb
            image={item.image}
            custom={item.custom}
            className="size-full transition-transform duration-300 group-hover:scale-[1.04]"
            iconClassName="size-8"
          />
          {item.active && (
            <span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full shadow">
              <Check className="size-3.5" />
            </span>
          )}
          <div className="absolute top-1.5 left-1.5 flex gap-1">
            {item.custom ? (
              <Badge className="bg-amber-500/90 text-white">{t("loraPicker.badgeCustom")}</Badge>
            ) : item.downloaded && !item.active ? (
              <Badge className="bg-emerald-600/90 text-white">{t("loraPicker.badgeDownloaded")}</Badge>
            ) : null}
            {item.nsfw && <Badge className="bg-rose-600/90 text-white">NSFW</Badge>}
          </div>
          {downloading ? (
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/60 px-2 py-1 text-[11px] text-white">
              <Loader2 className="size-3 animate-spin" />
              {t("loraPicker.downloading", { percent: item.progress })}
            </div>
          ) : (
            !item.custom &&
            !item.downloaded &&
            item.sizeBytes !== undefined &&
            item.sizeBytes > 0 && (
              <Badge className="bg-background/85 text-foreground absolute right-1.5 bottom-1.5">
                {formatSize(item.sizeBytes)}
              </Badge>
            )
          )}
        </div>
        <div className="min-w-0 p-2">
          <div className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </div>
          <div className="text-muted-foreground truncate text-[11px]" title={item.description}>
            {item.description || " "}
          </div>
        </div>
      </button>

      {item.onRemove && !downloading && (
        <button
          type="button"
          onClick={item.onRemove}
          title={item.removeTitle}
          aria-label={item.removeTitle}
          className="text-muted-foreground hover:text-destructive hover:bg-background absolute right-1.5 bottom-1.5 rounded-md p-1 opacity-0 transition group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function LoraThumb({
  image,
  custom,
  className,
  iconClassName,
}: {
  image?: string;
  custom?: boolean;
  className?: string;
  iconClassName?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (image && !broken) {
    return <img src={image} alt="" className={cn("object-cover", className)} onError={() => setBroken(true)} />;
  }
  return (
    <span
      className={cn(
        "flex items-center justify-center",
        custom ? "bg-amber-500/15 text-amber-600 dark:text-amber-300" : "brand-surface text-white",
        className
      )}
    >
      {custom ? <FileBox className={iconClassName} /> : <Sparkles className={iconClassName} />}
    </span>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide shadow-sm", className)}>
      {children}
    </span>
  );
}
