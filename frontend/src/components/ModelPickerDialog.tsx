import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Check, FileBox, PackageOpen, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, creditsToUSD } from "@/lib/utils";
import type { ModelInfo, PaymentMode } from "@/lib/types";

// Display label + ordering for the LOCAL backends the cards group by. Keys are
// the normalized BackendType (cloud.normalizeEngine). Family names are proper
// nouns (not translated); only "Cloud API" goes through i18n.
const TYPE_LABEL: Record<string, string> = {
  sdxl: "SDXL",
  sd15: "SD 1.5",
  zimage: "Z-Image",
  flux: "FLUX",
  chroma: "Chroma",
  qwenimage: "Qwen-Image",
  anima: "Anima",
  wan: "WAN Video",
};
const TYPE_ORDER = ["sdxl", "sd15", "zimage", "flux", "chroma", "qwenimage", "anima", "wan"];
// Family groups sort after every local backend, and the nameless bucket last.
const FAMILY_RANK_BASE = TYPE_ORDER.length;
const UNGROUPED_RANK = FAMILY_RANK_BASE + 10_000;

// The media row sits ABOVE the backend/family chips and narrows what they even
// describe: pick Video and the second row collapses to the backends that make
// video. Kind comes resolved from the Go side (catalog model_type, else the
// engine), so this file never guesses what a model produces.
const MEDIA_FILTERS = ["all", "image", "video"] as const;
type MediaFilter = (typeof MEDIA_FILTERS)[number];

function matchesMedia(m: ModelInfo, filter: MediaFilter): boolean {
  if (filter === "all") return true;
  // An unclassified model reads as an image: that is what the catalog's own
  // fallback does, and it keeps a row visible under one chip rather than
  // vanishing from both.
  return (m.modelType || "image") === filter;
}

// A model's group. Models the sidecar can run group by their backend — that's
// the thing that decides what actually loads. A cloud-only model has no backend
// to group by, so it falls back to the catalog family it belongs to (MiniMax,
// OpenAI, …): without that, every external model landed in one "Cloud API"
// bucket, which said nothing about what the model IS. The prefix keeps a family
// code from colliding with a backend name of the same spelling.
function groupKey(m: ModelInfo): string {
  if (m.backendType) return m.backendType;
  return m.familyCode ? `family:${m.familyCode}` : "";
}

function groupLabel(m: ModelInfo, t: TFunction): string {
  if (m.backendType) return TYPE_LABEL[m.backendType] ?? m.backendType.toUpperCase();
  // The catalog's family_name is the display name — it stays as written there.
  return m.familyName || t("modelPicker.typeCloudApi");
}

function groupRank(m: ModelInfo): number {
  if (m.backendType) {
    const i = TYPE_ORDER.indexOf(m.backendType);
    return i === -1 ? FAMILY_RANK_BASE - 1 : i; // unknown backend: just before families
  }
  if (m.familyCode) return FAMILY_RANK_BASE + (m.familyOrder || 0);
  return UNGROUPED_RANK;
}

function matches(m: ModelInfo, q: string): boolean {
  if (!q) return true;
  const hay = `${m.name} ${m.shortDescription} ${m.mediumDescription} ${m.familyName ?? ""} ${m.backendType ?? ""}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => hay.includes(tok));
}

type Group = { key: string; label: string; rank: number; items: ModelInfo[] };

// Group models (by backend, else by catalog family), groups by rank then label,
// models within a group by catalog `order` then name.
function groupModels(models: ModelInfo[], t: TFunction): Group[] {
  const byKey = new Map<string, Group>();
  for (const m of models) {
    const key = groupKey(m);
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: groupLabel(m, t), rank: groupRank(m), items: [] };
      byKey.set(key, g);
    }
    g.items.push(m);
  }
  return [...byKey.values()]
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map((g) => ({
      ...g,
      items: g.items.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name)),
    }));
}

export function ModelPickerDialog({
  open,
  onOpenChange,
  mode,
  paymentMode,
  catalog,
  customModels,
  activeCode,
  cachedCodes,
  busy,
  onPick,
  onAddCustom,
  onRemoveCustom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "local" | "cloud";
  /** Active cloud payment method — decides whether cost shows as credits or USD. */
  paymentMode: PaymentMode;
  catalog: ModelInfo[];
  customModels: ModelInfo[];
  activeCode: string | null;
  /** Local model codes whose weights are already downloaded. */
  cachedCodes: Set<string>;
  busy: boolean;
  onPick: (m: ModelInfo) => void;
  onAddCustom: () => void;
  onRemoveCustom: (m: ModelInfo) => void;
}) {
  const { t } = useTranslation();
  const isCloud = mode === "cloud";
  const [tab, setTab] = useState<"catalog" | "mine">("catalog");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");

  // Which list feeds the grid: cloud is catalog-only; local has a Catalog tab
  // and a "My models" tab (user-loaded checkpoints from the settings registry).
  const source = isCloud ? catalog : tab === "mine" ? customModels : catalog;

  // Only offer the media row when the list actually holds both kinds — a chip
  // that can only ever be "all" is noise.
  const showMedia = useMemo(
    () => new Set(source.map((m) => m.modelType || "image")).size > 1,
    [source]
  );

  // Everything below the media row describes the media selection: the backend
  // chips and the grid both read from this narrowed list.
  const mediaSource = useMemo(
    () => (showMedia ? source.filter((m) => matchesMedia(m, mediaFilter)) : source),
    [source, mediaFilter, showMedia]
  );

  // Filter chips reflect only the groups present in the current source
  // (post-tab, post-media), pre-search, so the filter row stays relevant. Built
  // from the same grouping as the grid, so chip and section always agree on
  // label+order.
  const presentGroups = useMemo(
    () => groupModels(mediaSource, t).map((g) => ({ key: g.key, label: g.label })),
    [mediaSource, t]
  );

  // Switching media can strip the backend the second row was filtering on
  // (picking Video with SDXL selected). Drop back to "all" rather than render
  // an empty grid under a chip that no longer exists.
  useEffect(() => {
    if (typeFilter !== "all" && !presentGroups.some((g) => g.key === typeFilter)) {
      setTypeFilter("all");
    }
  }, [presentGroups, typeFilter]);

  const groups = useMemo(() => {
    const filtered = mediaSource.filter(
      (m) => (typeFilter === "all" || groupKey(m) === typeFilter) && matches(m, search)
    );
    return groupModels(filtered, t);
  }, [mediaSource, typeFilter, search, t]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const showMine = !isCloud && tab === "mine";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle>{isCloud ? t("modelPicker.cloudTitle") : t("modelPicker.localTitle")}</DialogTitle>
          <DialogDescription>
            {isCloud ? t("modelPicker.cloudDesc") : t("modelPicker.localDesc")}
          </DialogDescription>

          {/* Local: Catalog / My models tabs */}
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
                  {tabId === "catalog" ? t("modelPicker.catalogTab") : t("modelPicker.mineTab")}
                  {tabId === "mine" && customModels.length > 0 && (
                    <span className="ml-1.5 opacity-70">{customModels.length}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Search + type filter */}
          <div className="mt-2 flex flex-col gap-2">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("modelPicker.searchPlaceholder")}
                className="border-input bg-background h-9 w-full rounded-md border pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {showMedia && (
              <div className="flex flex-wrap gap-1.5">
                {MEDIA_FILTERS.map((f) => (
                  <Chip key={f} active={mediaFilter === f} onClick={() => setMediaFilter(f)}>
                    {t(`modelPicker.media.${f}`)}
                  </Chip>
                ))}
              </div>
            )}
            {presentGroups.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                <Chip active={typeFilter === "all"} onClick={() => setTypeFilter("all")}>
                  {t("common.all")}
                </Chip>
                {presentGroups.map((g) => (
                  <Chip key={g.key} active={typeFilter === g.key} onClick={() => setTypeFilter(g.key)}>
                    {g.label}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        </DialogHeader>

        {/* Body — scrollable grid of grouped cards */}
        <div className="max-h-[55vh] overflow-y-auto px-5 py-4">
          {showMine && (
            <button
              type="button"
              onClick={onAddCustom}
              className="border-border/70 hover:border-primary/50 hover:bg-accent/50 mb-4 flex w-full items-center gap-3 rounded-xl border border-dashed px-4 py-3 text-left transition"
            >
              <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
                <Plus className="size-5" />
              </span>
              <div>
                <div className="text-sm font-medium">{t("modelPicker.addCheckpoint")}</div>
                <div className="text-muted-foreground text-xs">
                  {t("modelPicker.addCheckpointHint")}
                </div>
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
                  ? t("modelPicker.emptyMine")
                  : search || typeFilter !== "all"
                    ? t("modelPicker.emptyFiltered")
                    : t("modelPicker.empty")}
              </p>
              {showMine && (
                <button
                  type="button"
                  onClick={onAddCustom}
                  className="text-primary hover:bg-primary/10 border-primary/30 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors"
                >
                  <Plus className="size-3.5" /> {t("modelPicker.addCheckpoint")}
                </button>
              )}
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.key} className="mb-5 last:mb-0">
                <h4 className="text-muted-foreground mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
                  {g.label}
                  <span className="bg-border h-px flex-1" />
                  <span className="opacity-70">{g.items.length}</span>
                </h4>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {g.items.map((m) => (
                    <ModelCard
                      key={m.modelCode}
                      m={m}
                      isCloud={isCloud}
                      paymentMode={paymentMode}
                      active={m.modelCode === activeCode}
                      cached={!isCloud && cachedCodes.has(m.modelCode)}
                      disabled={busy}
                      onPick={() => onPick(m)}
                      onRemove={m.localPath ? () => onRemoveCustom(m) : undefined}
                    />
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

function ModelCard({
  m,
  isCloud,
  paymentMode,
  active,
  cached,
  disabled,
  onPick,
  onRemove,
}: {
  m: ModelInfo;
  isCloud: boolean;
  paymentMode: PaymentMode;
  active: boolean;
  /** Weights already on disk — selecting it reloads instead of downloading. */
  cached: boolean;
  disabled: boolean;
  onPick: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "group bg-card relative flex flex-col overflow-hidden rounded-xl border text-left transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:shadow-md",
        active ? "border-primary ring-primary/20 ring-2" : "hover:border-primary/40"
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onPick}
        className="flex flex-col text-left disabled:cursor-not-allowed disabled:opacity-60"
      >
        <div className="bg-muted relative aspect-square w-full overflow-hidden">
          <ModelThumb
            m={m}
            isCloud={isCloud}
            className="size-full transition-transform duration-300 group-hover:scale-[1.04]"
            iconClassName="size-8"
          />
          {active && (
            <span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full shadow">
              <Check className="size-3.5" />
            </span>
          )}
          <div className="absolute top-1.5 left-1.5 flex gap-1">
            {m.localPath ? (
              <Badge className="bg-amber-500/90 text-white">{t("modelPicker.badgeCustom")}</Badge>
            ) : !m.modelUrl && !isCloud ? (
              <Badge className="bg-black/60 text-white">{t("modelPicker.badgeCloudOnly")}</Badge>
            ) : cached ? (
              // Weights already downloaded: picking this is a reload, not a
              // multi-GB pull. Hidden on the active card — the check mark
              // already says more than "on disk" does.
              !active && <Badge className="bg-emerald-600/90 text-white">{t("modelPicker.badgeCached")}</Badge>
            ) : null}
          </div>
          {isCloud && m.cost > 0 && (
            <Badge className="bg-background/85 text-foreground absolute right-1.5 bottom-1.5">
              {paymentMode === "x402"
                ? t("modelPicker.costUsd", { usd: creditsToUSD(m.cost) })
                : t("modelPicker.cost", { cost: m.cost })}
            </Badge>
          )}
        </div>
        <div className="min-w-0 p-2">
          <div className="truncate text-sm font-medium" title={m.name}>
            {m.name}
          </div>
          <div
            className="text-muted-foreground truncate text-[11px]"
            title={m.shortDescription || m.localPath || undefined}
          >
            {m.shortDescription || m.localPath || " "}
          </div>
        </div>
      </button>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={t("modelPicker.removeTitle")}
          aria-label={t("modelPicker.removeAria")}
          className="text-muted-foreground hover:text-destructive hover:bg-background absolute right-1.5 bottom-1.5 rounded-md p-1 opacity-0 transition group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

// ModelThumb renders the catalog preview image (falling back to a type-flavoured
// placeholder on missing / broken images). Exported so the ModelBar trigger can
// show the active model's thumbnail with the same look.
export function ModelThumb({
  m,
  isCloud,
  className,
  iconClassName,
}: {
  m: ModelInfo | null;
  isCloud: boolean;
  className?: string;
  iconClassName?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (m?.image && !broken) {
    return (
      <img
        src={m.image}
        alt=""
        className={cn("object-cover", className)}
        onError={() => setBroken(true)}
      />
    );
  }
  const isCustom = !!m?.localPath;
  return (
    <span
      className={cn(
        "flex items-center justify-center",
        isCustom
          ? "bg-amber-500/15 text-amber-600 dark:text-amber-300"
          : isCloud
            ? "bg-[linear-gradient(135deg,var(--cloud-from),var(--cloud-to))] text-white"
            : "brand-surface text-white",
        className
      )}
    >
      {isCustom ? <FileBox className={iconClassName} /> : <Sparkles className={iconClassName} />}
    </span>
  );
}

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide shadow-sm",
        className
      )}
    >
      {children}
    </span>
  );
}
