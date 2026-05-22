import { useEffect, useMemo, useRef, useState } from "react";
import { X, Trash2, Pause, Play, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/wails-bridge";
import type { LogEntry, LogLevel } from "@/lib/types";

const MAX_ENTRIES = 2000;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function LogPanel({ open, onOpenChange }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [minLevel, setMinLevel] = useState<LogLevel>("trace");
  const pausedBufferRef = useRef<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Seed once on mount, then stream forever (the panel doesn't unmount on
  // close — we just hide it — so the bus subscription survives).
  useEffect(() => {
    let cancelled = false;
    void api.getLogs().then((seed) => {
      if (!cancelled) setEntries(seed.slice(-MAX_ENTRIES));
    });

    const off = api.onLogEntry((e) => {
      if (paused) {
        pausedBufferRef.current.push(e);
        return;
      }
      setEntries((prev) => {
        // Dedupe by id: in StrictMode dev (and across Wails event re-deliveries
        // we've observed in practice), the same entry sometimes appears twice.
        // Cheap check on the tail first — that's the typical case.
        if (prev.length > 0 && prev[prev.length - 1].id === e.id) return prev;
        const next = prev.length >= MAX_ENTRIES ? prev.slice(prev.length - MAX_ENTRIES + 1) : prev;
        return [...next, e];
      });
    });
    return () => {
      cancelled = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  // When paused is released, drain the buffer.
  useEffect(() => {
    if (paused) return;
    if (pausedBufferRef.current.length === 0) return;
    const drained = pausedBufferRef.current;
    pausedBufferRef.current = [];
    setEntries((prev) => {
      // Drop drained entries that are already in `prev` (race with the
      // re-subscription that happens on `paused` flip — the new stream
      // handler might have already pushed some of these).
      const knownIds = new Set(prev.map((p) => p.id));
      const fresh = drained.filter((e) => !knownIds.has(e.id));
      if (fresh.length === 0) return prev;
      const merged = [...prev, ...fresh];
      return merged.length > MAX_ENTRIES ? merged.slice(-MAX_ENTRIES) : merged;
    });
  }, [paused]);

  // Auto-scroll to bottom when new entries arrive (unless user opted out).
  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, autoScroll]);

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) set.add(e.source);
    return Array.from(set).sort();
  }, [entries]);

  const filtered = useMemo(() => {
    const minRank = levelRank(minLevel);
    // Final-line dedupe on render: catches duplicates from the merge points
    // (paused buffer drain, getLogs seed racing with stream events) that the
    // tail-only check in setEntries can miss. O(N) per filter recompute.
    const seen = new Set<number>();
    return entries.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return (
        levelRank(e.level) >= minRank &&
        (sourceFilter === "" || e.source === sourceFilter)
      );
    });
  }, [entries, sourceFilter, minLevel]);

  const errorCount = useMemo(
    () => entries.reduce((n, e) => (e.level === "error" ? n + 1 : n), 0),
    [entries]
  );

  return (
    <div
      className={
        "fixed top-0 right-0 z-40 h-screen w-[640px] max-w-[100vw] transform border-l bg-background shadow-2xl transition-transform duration-200 " +
        (open ? "translate-x-0" : "translate-x-full")
      }
      // Don't unmount on close — keep the subscription alive so the panel
      // doesn't miss entries when hidden.
      aria-hidden={!open}
    >
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Logs</h2>
          <span className="text-muted-foreground text-xs">
            {entries.length} total · {filtered.length} shown
            {errorCount > 0 ? ` · ${errorCount} errors` : ""}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume streaming" : "Pause streaming"}
          >
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAutoScroll((s) => !s)}
            title={autoScroll ? "Auto-scroll on (click to disable)" : "Auto-scroll off"}
          >
            <ChevronDown
              className={"size-4 " + (autoScroll ? "" : "opacity-40")}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void api.clearLogs();
              setEntries([]);
              pausedBufferRef.current = [];
            }}
            title="Clear"
          >
            <Trash2 className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            title="Close"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs">
        <label className="text-muted-foreground">level ≥</label>
        <select
          className="rounded border bg-background px-2 py-1 text-xs"
          value={minLevel}
          onChange={(e) => setMinLevel(e.target.value as LogLevel)}
        >
          <option value="trace">trace</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <label className="text-muted-foreground ml-3">source</label>
        <select
          className="rounded border bg-background px-2 py-1 text-xs"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
        >
          <option value="">all</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div
        ref={scrollRef}
        className="h-[calc(100vh-92px)] overflow-y-auto font-mono text-xs"
      >
        {filtered.length === 0 ? (
          <p className="text-muted-foreground p-6 text-center">No entries.</p>
        ) : (
          filtered.map((e) => <LogRow key={e.id} entry={e} />)
        )}
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasData = entry.data !== undefined && entry.data !== null;
  const time = entry.timestamp.slice(11, 23); // HH:MM:SS.mmm

  return (
    <div
      className={
        "border-b px-3 py-1.5 leading-snug " +
        levelBg(entry.level) +
        (hasData ? " cursor-pointer hover:bg-muted/30" : "")
      }
      onClick={() => hasData && setExpanded((e) => !e)}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground shrink-0 tabular-nums">{time}</span>
        <span className={"shrink-0 font-semibold uppercase " + levelText(entry.level)}>
          {entry.level}
        </span>
        <span className="text-muted-foreground shrink-0">[{entry.source}]</span>
        <span className="whitespace-pre-wrap break-words">{entry.message}</span>
      </div>
      {hasData && expanded && (
        <pre className="bg-muted/40 mt-1 overflow-x-auto rounded p-2 text-[11px]">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function levelRank(l: LogLevel): number {
  return l === "trace" ? 0 : l === "info" ? 1 : l === "warn" ? 2 : 3;
}

function levelBg(l: LogLevel): string {
  switch (l) {
    case "error":
      return "bg-red-500/8";
    case "warn":
      return "bg-yellow-500/8";
    case "trace":
      return "opacity-70";
    default:
      return "";
  }
}

function levelText(l: LogLevel): string {
  switch (l) {
    case "error":
      return "text-red-600";
    case "warn":
      return "text-yellow-700";
    case "info":
      return "text-blue-600";
    default:
      return "text-muted-foreground";
  }
}
