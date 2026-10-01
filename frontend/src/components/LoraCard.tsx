import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, FileBox, Loader2, PackageOpen, Plus, Search, Sparkles, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AddButton, ComposerCardHeader } from "@/components/ComposerCard";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import type { AppSettings, CatalogLora, CloudLoraRef, LoraEntry, LoraRef } from "@/lib/types";

/** Backends whose local engine applies user LoRAs. Mirrors the Go gate
 *  (internal/loras.BackendSupports) — flip both when a family is enabled. */
export const LORA_BACKENDS = new Set(["sdxl", "zimage", "krea2", "anima"]);

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

/** A catalog LoRA goes on a model of that engine whose family it lists (a user
 *  checkpoint has no catalog family: the engine alone decides). Same rule as
 *  imference's resolveLoras. */
export function catalogFits(lora: CatalogLora, backend: string, familyCode?: string): boolean {
  if (lora.engine !== backend) return false;
  return !familyCode || lora.compatibleFamilyCodes.includes(familyCode);
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

function familyLabel(lora: CatalogLora): string {
  return lora.familyName || lora.familyCode.toUpperCase();
}

function fitsHint(t: TFunction, families: string[]): string {
  return t("loraPicker.otherFamilyHint", { families: families.map((f) => f.toUpperCase()).join(", ") });
}

// ---------------------------------------------------------------------------
// Composer cards: the selected LoRAs + an "Add" button that opens the picker.
// ---------------------------------------------------------------------------

// Local mode. The picker shows the whole curated catalog (compatible ones
// usable; a pick downloads the file once into the app's LoRA folder, SHA256-
// checked, then selects it) and "My LoRAs" (imported files, referenced in
// place). Selections are library paths.
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
          if (entry && !active.some((a) => a.path === entry.path) && active.length < MAX_ACTIVE_LORAS) {
            onActiveChange([...active, { path: entry.path, weight: initialWeight(entry) }]);
          }
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
      onSettingsChange(await api.addLora(path));
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
    const fits = catalogFits(lora, backend, familyCode);
    return {
      key: `catalog:${lora.code}`,
      name: lora.name,
      description: lora.shortDescription,
      image: lora.image,
      category: lora.category,
      sizeBytes: lora.sizeBytes,
      group: familyLabel(lora),
      compatible: fits,
      incompatibleHint: fits ? undefined : fitsHint(t, lora.compatibleFamilyCodes),
      downloaded: !!entry,
      active: !!entry && isActive(entry.path),
      progress: downloading[lora.code],
      onPick: () => void pickCatalog(lora),
      onRemove: entry ? () => void removeFromLibrary(entry) : undefined,
      removeTitle: t("lora.removeDownloaded"),
    };
  });
  const mineItems: PickerItem[] = library
    .filter((l) => !l.catalogCode)
    .map((entry) => {
      const fits = loraFits(entry, backend, familyCode);
      return {
        key: `mine:${entry.path}`,
        name: entry.name,
        description: entry.path,
        custom: true,
        sizeBytes: entry.sizeBytes,
        group: entry.family ? entry.family.toUpperCase() : t("loraPicker.unknownFamily"),
        compatible: fits,
        incompatibleHint: fits ? undefined : fitsHint(t, [entry.family ?? "?"]),
        active: isActive(entry.path),
        onPick: () => pickMine(entry),
        onRemove: () => void removeFromLibrary(entry),
        removeTitle: t("lora.remove"),
      };
    });

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

// Cloud mode: the whole curated catalog, the ones fitting the selected cloud
// model usable; imference applies them on its workers, nothing is downloaded.
// Selections are catalog codes; ones the current model doesn't take are dropped.
export function CloudLoraCard({
  backend,
  modelCode,
  familyCode,
  active,
  onActiveChange,
  onInsertTrigger,
}: {
  backend: string;
  modelCode: string;
  familyCode?: string;
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
    const fitting = new Set(loras.filter((l) => catalogFits(l, backend, familyCode)).map((l) => l.code));
    if (active.some((a) => !fitting.has(a.code))) onActiveChange(active.filter((a) => fitting.has(a.code)));
  }, [loras, active, onActiveChange, backend, familyCode]);

  // Empty catalog: nothing to add, no card.
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

  const items: PickerItem[] = loras.map((lora) => {
    const fits = catalogFits(lora, backend, familyCode);
    return {
      key: lora.code,
      name: lora.name,
      description: lora.shortDescription,
      image: lora.image,
      category: lora.category,
      group: familyLabel(lora),
      compatible: fits,
      incompatibleHint: fits ? undefined : fitsHint(t, lora.compatibleFamilyCodes),
      active: isActive(lora.code),
      onPick: () => toggle(lora),
    };
  });

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
  const full = count >= MAX_ACTIVE_LORAS;
  return (
    <section className="bg-card rounded-2xl border px-4 py-3 shadow-sm">
      <ComposerCardHeader
        title={t("lora.title")}
        optionalLabel={t("lora.optional")}
        help={t("lora.help")}
        action={
          <AddButton
            label={t("lora.add")}
            onClick={onAdd}
            disabled={full}
            title={full ? t("lora.tooMany", { max: MAX_ACTIVE_LORAS }) : undefined}
          />
        }
      />
      {count > 0 && <ul className="mt-3 grid gap-3">{children}</ul>}
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
              title={triggersNeeded ? t("lora.triggerNeeded") : t("lora.triggerOptional")}
              className="bg-muted hover:bg-accent rounded px-1.5 py-0.5 font-mono text-[10px]"
            >
              + {word}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Picker dialog — same shape as ModelPickerDialog: tabs (local), search,
// category chips, family-grouped card grid. Every LoRA is shown; the ones that
// don't fit the selected model are dimmed and can't be picked.
// ---------------------------------------------------------------------------

type PickerItem = {
  key: string;
  name: string;
  description?: string;
  image?: string;
  category?: string;
  sizeBytes?: number;
  /** Section the card sits in (the LoRA's family). */
  group: string;
  /** Goes on the selected model. Others are shown dimmed, not pickable. */
  compatible: boolean;
  incompatibleHint?: string;
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
  const hay = `${item.name} ${item.description ?? ""} ${item.category ?? ""} ${item.group}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
}

type Group = { label: string; items: PickerItem[]; compatible: number };

// Sections by family: the ones holding compatible LoRAs first, then by name;
// inside a section compatible cards first, then by name.
function groupItems(items: PickerItem[]): Group[] {
  const byLabel = new Map<string, Group>();
  for (const item of items) {
    let g = byLabel.get(item.group);
    if (!g) {
      g = { label: item.group, items: [], compatible: 0 };
      byLabel.set(item.group, g);
    }
    g.items.push(item);
    if (item.compatible) g.compatible++;
  }
  return [...byLabel.values()]
    .sort((a, b) => Number(b.compatible > 0) - Number(a.compatible > 0) || a.label.localeCompare(b.label))
    .map((g) => ({
      ...g,
      items: g.items.sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.name.localeCompare(b.name)),
    }));
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
  const [fitsOnly, setFitsOnly] = useState(false);

  const source = isCloud || tab === "catalog" ? catalog : mine;
  const presentCategories = useMemo(() => {
    const present = new Set(source.map((i) => i.category || "other"));
    return CATEGORIES.filter((c) => present.has(c));
  }, [source]);

  useEffect(() => {
    if (category !== "all" && !presentCategories.includes(category)) setCategory("all");
  }, [presentCategories, category]);

  const groups = groupItems(
    source.filter(
      (i) =>
        (!fitsOnly || i.compatible) &&
        (category === "all" || (i.category || "other") === category) &&
        matches(i, search)
    )
  );
  const total = groups.reduce((n, g) => n + g.items.length, 0);
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
            <div className="flex flex-wrap gap-1.5">
              <Chip active={fitsOnly} onClick={() => setFitsOnly((v) => !v)}>
                {t("loraPicker.fitsOnly")}
              </Chip>
              {presentCategories.length > 1 && (
                <>
                  <span className="bg-border mx-0.5 w-px self-stretch" />
                  <Chip active={category === "all"} onClick={() => setCategory("all")}>
                    {t("common.all")}
                  </Chip>
                  {presentCategories.map((c) => (
                    <Chip key={c} active={category === c} onClick={() => setCategory(c)}>
                      {t(`loraPicker.category.${c}`)}
                    </Chip>
                  ))}
                </>
              )}
            </div>
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

          {total === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-3 py-12 text-center">
              <div className="bg-muted flex size-12 items-center justify-center rounded-2xl">
                <PackageOpen className="size-6 opacity-70" strokeWidth={1.75} />
              </div>
              <p className="text-sm">
                {showMine
                  ? t("loraPicker.emptyMine")
                  : search || category !== "all" || fitsOnly
                    ? t("loraPicker.emptyFiltered")
                    : t("loraPicker.empty")}
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.label} className="mb-5 last:mb-0">
                <h4 className="text-muted-foreground mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
                  {g.label}
                  <span className="bg-border h-px flex-1" />
                  <span className="opacity-70">{g.items.length}</span>
                </h4>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {g.items.map((item) => (
                    <LoraPickerCard key={item.key} item={item} />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LoraPickerCard({ item }: { item: PickerItem }) {
  const { t } = useTranslation();
  const downloading = item.progress !== undefined;
  const blocked = !item.compatible && !item.active;
  return (
    <div
      title={item.incompatibleHint}
      className={cn(
        "group bg-card relative flex flex-col overflow-hidden rounded-xl border text-left transition-[transform,box-shadow,border-color,opacity] duration-200",
        blocked ? "opacity-50" : "hover:-translate-y-0.5 hover:shadow-md",
        item.active ? "border-primary ring-primary/20 ring-2" : !blocked && "hover:border-primary/40"
      )}
    >
      <button
        type="button"
        disabled={downloading || blocked}
        onClick={item.onPick}
        className={cn("flex flex-col text-left", downloading && "cursor-progress", blocked && "cursor-not-allowed")}
      >
        <div className="bg-muted relative aspect-square w-full overflow-hidden">
          <LoraThumb
            image={item.image}
            custom={item.custom}
            className={cn(
              "size-full transition-transform duration-300",
              blocked ? "grayscale" : "group-hover:scale-[1.04]"
            )}
            iconClassName="size-8"
          />
          {item.active && (
            <span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full shadow">
              <Check className="size-3.5" />
            </span>
          )}
          <div className="absolute top-1.5 left-1.5 flex flex-wrap gap-1">
            {!item.compatible ? (
              <Badge className="bg-black/70 text-white">{t("loraPicker.badgeOtherFamily")}</Badge>
            ) : item.custom ? (
              <Badge className="bg-amber-500/90 text-white">{t("loraPicker.badgeCustom")}</Badge>
            ) : item.downloaded && !item.active ? (
              <Badge className="bg-emerald-600/90 text-white">{t("loraPicker.badgeDownloaded")}</Badge>
            ) : null}
          </div>
          {downloading ? (
            <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/60 px-2 py-1 text-[11px] text-white">
              <Loader2 className="size-3 animate-spin" />
              {t("loraPicker.downloading", { percent: item.progress })}
            </div>
          ) : (
            item.compatible &&
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
