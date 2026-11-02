import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Download, FileText, Film, ImageIcon, Loader2, Wrench } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/wails-bridge";
import { GALLERY_CHANGED_EVENT } from "@/lib/target";
import type { CloudHistoryItem, CloudHistoryOutput, CloudHistoryRail } from "@/lib/types";
import { cn } from "@/lib/utils";

// The cloud call history: every call the API key or the wallet paid for, read
// from the server. The server keeps the call and its results only (never the
// prompt or the settings) and serves result files for 24 h; within that window
// a result can be saved to the gallery again.
export function CloudHistoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [rail, setRail] = useState<CloudHistoryRail | "">("");
  const [rails, setRails] = useState<CloudHistoryRail[]>([]);
  const [items, setItems] = useState<CloudHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [retention, setRetention] = useState(24);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  // Drops answers of a request superseded by a newer one (rail switch).
  const seq = useRef(0);

  const load = useCallback((which: CloudHistoryRail | "", after?: string) => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    api
      .listCloudHistory(which, after ?? "")
      .then((page) => {
        if (n !== seq.current) return;
        setRails(page.rails ?? []);
        setRail(page.rail);
        setRetention(page.retention_hours || 24);
        setItems((cur) => (after ? [...cur, ...(page.data ?? [])] : page.data ?? []));
        setCursor(page.next_cursor || undefined);
      })
      .catch((e) => {
        if (n !== seq.current) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(/no API key or wallet/i.test(msg) ? t("history.noRail") : msg);
        if (!after) setItems([]);
      })
      .finally(() => {
        if (n === seq.current) setLoading(false);
      });
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setItems([]);
    setCursor(undefined);
    load(rail);
    // Reload on open only; the rail switch reloads itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const switchRail = (r: CloudHistoryRail) => {
    if (r === rail) return;
    setRail(r);
    setItems([]);
    setCursor(undefined);
    load(r);
  };

  const save = async (item: CloudHistoryItem, index: number) => {
    const key = `${item.request_id}:${index}`;
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      await api.redownloadCloudOutput(item, index);
      // The gallery reloads in place (desktop and web).
      window.dispatchEvent(new Event(GALLERY_CHANGED_EVENT));
      toast.success(t("history.saved"));
    } catch (e) {
      toast.error(t("history.saveFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  };

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime())
      ? iso
      : d.toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("history.title")}</DialogTitle>
          <DialogDescription>{t("history.desc", { hours: retention })}</DialogDescription>
        </DialogHeader>

        {rails.length > 1 && (
          <Segmented
            size="sm"
            value={(rail || rails[0]) as CloudHistoryRail}
            onChange={switchRail}
            items={rails.map((r) => ({ value: r, label: t(`history.rail.${r}`) }))}
          />
        )}

        <div className="-mx-1 min-h-40 flex-1 overflow-y-auto px-1">
          {error ? (
            <div className="text-muted-foreground flex items-start gap-2 rounded-lg border p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : items.length === 0 && !loading ? (
            <p className="text-muted-foreground py-10 text-center text-sm">{t("history.empty")}</p>
          ) : (
            <ul className="divide-border/60 divide-y">
              {items.map((item) => (
                <HistoryRow
                  key={item.request_id}
                  item={item}
                  date={fmtDate(item.created_at)}
                  until={item.available_until ? fmtDate(item.available_until) : null}
                  saving={saving}
                  onSave={save}
                />
              ))}
            </ul>
          )}
          {loading && (
            <div className="text-muted-foreground flex items-center justify-center gap-2 py-4 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t("common.loading")}
            </div>
          )}
          {!loading && cursor && !error && (
            <div className="flex justify-center py-3">
              <Button variant="outline" size="sm" onClick={() => load(rail, cursor)}>
                {t("history.more")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === "video") return <Film className={className} />;
  if (kind === "tool") return <Wrench className={className} />;
  if (kind === "text" || kind === "json") return <FileText className={className} />;
  return <ImageIcon className={className} />;
}

function HistoryRow({
  item,
  date,
  until,
  saving,
  onSave,
}: {
  item: CloudHistoryItem;
  date: string;
  until: string | null;
  saving: Record<string, boolean>;
  onSave: (item: CloudHistoryItem, index: number) => void;
}) {
  const { t } = useTranslation();
  const title = item.kind === "tool" && item.tool_id ? item.tool_id : t(`history.kind.${item.kind}`, item.kind);
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <KindIcon kind={item.kind} className="text-muted-foreground size-4" />
        <span className="font-medium">{title}</span>
        <StatusBadge status={item.status} />
        <span className="text-muted-foreground text-xs">{date}</span>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {item.rail === "x402"
            ? t("history.paidWallet")
            : item.status === "failed" && item.credits_charged === 0
              ? t("history.refunded")
              : t("history.credits", { count: item.credits_charged })}
        </span>
      </div>
      {item.status === "failed" && item.error && (
        <p className="text-destructive text-xs">{item.error}</p>
      )}
      {item.outputs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {item.outputs.map((o, i) => (
            <OutputChip
              key={i}
              output={o}
              expired={item.expired}
              busy={!!saving[`${item.request_id}:${i}`]}
              onSave={() => onSave(item, i)}
            />
          ))}
          <span className="text-muted-foreground text-xs">
            {item.expired ? t("history.expired") : until ? t("history.until", { date: until }) : null}
          </span>
        </div>
      )}
    </li>
  );
}

function StatusBadge({ status }: { status: CloudHistoryItem["status"] }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        status === "done" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        status === "failed" && "bg-destructive/15 text-destructive",
        status === "pending" && "bg-muted text-muted-foreground"
      )}
    >
      {t(`history.status.${status}`)}
    </span>
  );
}

function OutputChip({
  output,
  expired,
  busy,
  onSave,
}: {
  output: CloudHistoryOutput;
  expired: boolean;
  busy: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  const canSave = !expired && !!output.url;
  const thumb = canSave && output.kind === "image" && !broken;
  return (
    <div className="bg-muted/50 flex items-center gap-2 rounded-lg border p-1 pr-2">
      <div className="bg-muted flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md">
        {thumb ? (
          <img
            src={output.url}
            alt=""
            loading="lazy"
            className="size-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          <KindIcon kind={output.kind} className="text-muted-foreground/60 size-4" />
        )}
      </div>
      <div className="grid text-xs">
        <span className="font-medium">{output.name || t(`history.kind.${output.kind}`, output.kind)}</span>
        <span className="text-muted-foreground">
          {[output.format, output.width && output.height ? `${output.width}×${output.height}` : ""]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {output.text ? (
        <span className="text-muted-foreground max-w-48 truncate text-xs" title={output.text}>
          {output.text}
        </span>
      ) : canSave ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={onSave} title={t("history.save")}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />}
          {t("history.save")}
        </Button>
      ) : null}
    </div>
  );
}
