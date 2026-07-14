import { useMemo, useState } from "react";
import { Check, FileBox, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/types";

// Display label + ordering for each backend "type" the cards group by. Keys are
// the normalized BackendType (cloud.normalizeEngine); "" is the cloud-only
// external family (GPT-Image, Veo, …) with no local backend.
const TYPE_LABEL: Record<string, string> = {
  sdxl: "SDXL",
  sd15: "SD 1.5",
  zimage: "Z-Image",
  flux: "FLUX",
  chroma: "Chroma",
  qwenimage: "Qwen-Image",
  anima: "Anima",
  wan: "WAN Video",
  "": "Cloud API",
};
const TYPE_ORDER = ["sdxl", "sd15", "zimage", "flux", "chroma", "qwenimage", "anima", "wan", ""];

function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? (t ? t.toUpperCase() : "Other");
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

// Group models by backend type, ordered by TYPE_ORDER (unknown types last,
// alphabetical), models within a group by catalog `order` then name.
function groupByType(models: ModelInfo[]): { type: string; label: string; items: ModelInfo[] }[] {
  const byType = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const t = m.backendType ?? "";
    (byType.get(t) ?? byType.set(t, []).get(t)!).push(m);
  }
  const rank = (t: string) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length + 1 : i;
  };
  return [...byType.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([type, items]) => ({
      type,
      label: typeLabel(type),
      items: items.sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name)),
    }));
}

export function ModelPickerDialog({
  open,
  onOpenChange,
  mode,
  catalog,
  customModels,
  activeCode,
  busy,
  onPick,
  onAddCustom,
  onRemoveCustom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "local" | "cloud";
  catalog: ModelInfo[];
  customModels: ModelInfo[];
  activeCode: string | null;
  busy: boolean;
  onPick: (m: ModelInfo) => void;
  onAddCustom: () => void;
  onRemoveCustom: (m: ModelInfo) => void;
}) {
  const isCloud = mode === "cloud";
  const [tab, setTab] = useState<"catalog" | "mine">("catalog");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  // Which list feeds the grid: cloud is catalog-only; local has a Catalog tab
  // and a "My models" tab (user-loaded checkpoints from the settings registry).
  const source = isCloud ? catalog : tab === "mine" ? customModels : catalog;

  // Type chips reflect only the types present in the current source (post-tab),
  // pre-search, so the filter row stays relevant.
  const presentTypes = useMemo(() => {
    const seen = new Set(source.map((m) => m.backendType ?? ""));
    return TYPE_ORDER.filter((t) => seen.has(t)).concat(
      [...seen].filter((t) => !TYPE_ORDER.includes(t))
    );
  }, [source]);

  const groups = useMemo(() => {
    const filtered = source.filter(
      (m) => (typeFilter === "all" || (m.backendType ?? "") === typeFilter) && matches(m, search)
    );
    return groupByType(filtered);
  }, [source, typeFilter, search]);

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const showMine = !isCloud && tab === "mine";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 pt-5 pb-4">
          <DialogTitle>{isCloud ? "Cloud models" : "Local models"}</DialogTitle>
          <DialogDescription>
            {isCloud
              ? "Pick a model to run in the cloud — grouped by type."
              : "Pick a model to run on your machine, or bring your own checkpoint."}
          </DialogDescription>

          {/* Local: Catalog / My models tabs */}
          {!isCloud && (
            <div className="mt-1 flex gap-1">
              {(["catalog", "mine"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "rounded-lg px-3 py-1.5 text-xs font-medium transition",
                    tab === t ? "bg-primary text-primary-foreground" : "hover:bg-accent text-muted-foreground"
                  )}
                >
                  {t === "catalog" ? "Catalog" : "My models"}
                  {t === "mine" && customModels.length > 0 && (
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
                placeholder="Search models…"
                className="border-input bg-background h-9 w-full rounded-md border pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
            {presentTypes.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                <Chip active={typeFilter === "all"} onClick={() => setTypeFilter("all")}>
                  All
                </Chip>
                {presentTypes.map((t) => (
                  <Chip key={t} active={typeFilter === t} onClick={() => setTypeFilter(t)}>
                    {typeLabel(t)}
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
                <div className="text-sm font-medium">Add a checkpoint…</div>
                <div className="text-muted-foreground text-xs">
                  Load your own .safetensors (e.g. from Civitai)
                </div>
              </div>
            </button>
          )}

          {total === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">
              {showMine
                ? "No custom models yet — add one above."
                : search || typeFilter !== "all"
                  ? "No models match your filters."
                  : "No models available."}
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.type} className="mb-5 last:mb-0">
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
                      active={m.modelCode === activeCode}
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
  active,
  disabled,
  onPick,
  onRemove,
}: {
  m: ModelInfo;
  isCloud: boolean;
  active: boolean;
  disabled: boolean;
  onPick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        "group bg-card relative flex flex-col overflow-hidden rounded-xl border text-left transition",
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
          <ModelThumb m={m} isCloud={isCloud} className="size-full" iconClassName="size-8" />
          {active && (
            <span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full shadow">
              <Check className="size-3.5" />
            </span>
          )}
          <div className="absolute top-1.5 left-1.5 flex gap-1">
            {m.localPath ? (
              <Badge className="bg-amber-500/90 text-white">custom</Badge>
            ) : !m.modelUrl && !isCloud ? (
              <Badge className="bg-black/60 text-white">cloud-only</Badge>
            ) : null}
          </div>
          {isCloud && m.cost > 0 && (
            <Badge className="bg-background/85 text-foreground absolute right-1.5 bottom-1.5">
              {m.cost} cr
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
          title="Remove from list (the file is not deleted)"
          aria-label="Remove custom model"
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
            ? "bg-gradient-to-br from-sky-400 to-blue-600 text-white"
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
