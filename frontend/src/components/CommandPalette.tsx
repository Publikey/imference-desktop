import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// CommandPalette — a ⌘K / Ctrl+K launcher over a flat list of commands. The
// palette is generic: App builds the command registry (the single source of
// truth for app actions) and passes it in. Fuzzy-ish substring search, full
// keyboard navigation, grouped display, and a self-installed global open combo.
// ---------------------------------------------------------------------------

export type Command = {
  id: string;
  /** Section header the command is listed under (already localized). */
  group: string;
  /** Localized, human-facing label. */
  label: string;
  icon?: ReactNode;
  /** Extra search terms (synonyms) beyond the label/group. */
  keywords?: string;
  /** Key chips shown on the right, e.g. ["⌘", "↵"] — display only. */
  shortcut?: string[];
  run: () => void;
};

const isMac =
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform || "");
/** The platform's primary modifier label — "⌘" on macOS, "Ctrl" elsewhere. */
export const modLabel = isMac ? "⌘" : "Ctrl";

// Rank a command against the query tokens (all must match). Higher = better:
// a label prefix beats a label substring beats a keyword-only hit.
function score(c: Command, tokens: string[]): number | null {
  const label = c.label.toLowerCase();
  const hay = `${label} ${c.group.toLowerCase()} ${(c.keywords ?? "").toLowerCase()}`;
  for (const tok of tokens) if (!hay.includes(tok)) return null;
  const q = tokens.join(" ");
  if (label.startsWith(q)) return 3;
  if (label.includes(q)) return 2;
  return 1;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="bg-muted text-muted-foreground inline-flex min-w-[1.25rem] items-center justify-center rounded px-1 py-0.5 text-[10px] font-medium leading-none">
      {children}
    </kbd>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Read latest `open` inside the always-installed key listener without
  // re-subscribing on every toggle.
  const openRef = useRef(open);
  openRef.current = open;

  // Global keys: ⌘K / Ctrl+K toggles the palette; Escape closes it. Handling
  // Escape at the window level (not just on the input) keeps it working even if
  // focus briefly lands elsewhere. preventDefault on ⌘K stops the webview's own
  // find-in-page on some platforms.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        onOpenChange(!openRef.current);
      } else if (e.key === "Escape" && openRef.current) {
        e.preventDefault();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  // Fresh query + focus each time it opens.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const filtered = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return commands;
    return commands
      .map((c) => ({ c, s: score(c, tokens) }))
      .filter((x): x is { c: Command; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [commands, query]);

  // Reset the highlight to the top whenever the result set changes.
  useEffect(() => setActive(0), [query]);

  const runAt = useCallback(
    (i: number) => {
      const cmd = filtered[i];
      if (!cmd) return;
      onOpenChange(false);
      cmd.run();
    },
    [filtered, onOpenChange]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = filtered.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (n ? (i + 1) % n : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (n ? (i - 1 + n) % n : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  };

  // Keep the highlighted row visible during keyboard navigation.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  // Walk the flat (already-ranked) list, emitting a group header whenever the
  // group changes — the flat index still drives selection.
  let lastGroup = "";
  const rows = filtered.map((c, i) => {
    const header = c.group !== lastGroup ? c.group : null;
    lastGroup = c.group;
    return { c, i, header };
  });

  return (
    <div
      className="animate-in fade-in fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm duration-150"
      onClick={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        className="animate-in zoom-in-95 slide-in-from-top-2 bg-popover w-full max-w-lg overflow-hidden rounded-2xl border shadow-2xl duration-150"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
      >
        <div className="flex items-center gap-2.5 border-b px-4">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("palette.placeholder")}
            role="combobox"
            aria-expanded
            aria-controls="cmdk-list"
            aria-activedescendant={filtered.length ? `cmdk-${active}` : undefined}
            className="placeholder:text-muted-foreground/60 h-12 w-full bg-transparent text-sm outline-none"
          />
        </div>

        <div id="cmdk-list" ref={listRef} role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <p className="text-muted-foreground px-3 py-8 text-center text-sm">{t("palette.empty")}</p>
          ) : (
            rows.map(({ c, i, header }) => (
              <Fragment key={c.id}>
                {header && (
                  <div className="text-muted-foreground/60 px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider">
                    {header}
                  </div>
                )}
                <button
                  id={`cmdk-${i}`}
                  data-idx={i}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => runAt(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors [&_svg]:size-4",
                    i === active ? "bg-accent text-accent-foreground" : "text-foreground"
                  )}
                >
                  <span className={cn("shrink-0", i === active ? "text-foreground" : "text-muted-foreground")}>
                    {c.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.shortcut && (
                    <span className="flex shrink-0 items-center gap-1">
                      {c.shortcut.map((k, j) => (
                        <Kbd key={j}>{k}</Kbd>
                      ))}
                    </span>
                  )}
                </button>
              </Fragment>
            ))
          )}
        </div>

        <div className="text-muted-foreground/60 flex items-center gap-3 border-t px-4 py-2 text-[10px]">
          <span className="inline-flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t("palette.navigate")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>↵</Kbd>
            {t("palette.select")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Kbd>esc</Kbd>
            {t("palette.close")}
          </span>
        </div>
      </div>
    </div>
  );
}
