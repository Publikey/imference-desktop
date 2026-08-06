import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, HardDrive, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProgressBar } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { api } from "@/lib/wails-bridge";
import { cn } from "@/lib/utils";
import type { AppSettings, CachedModel, FolderSizes, StorageInfo } from "@/lib/types";

const GB = 1024 ** 3;

// Floor mirroring app.go's minAllowedQuotaBytes: below this nothing useful fits
// and every model switch would thrash the cache.
const MIN_QUOTA_GB = 8;

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// "3 days ago" style, coarse on purpose — the exact minute never matters here.
function relativeTime(iso: string, t: ReturnType<typeof useTranslation>["t"]): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return t("storage.daysAgo", { count: days });
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return t("storage.hoursAgo", { count: hours });
  return t("storage.justNow");
}

// Bytes → whole GB for the number inputs. Settings store bytes so the Go side
// needs no unit conversion; the UI only ever shows GB.
function toGB(bytes: number | undefined, fallback: number): number {
  return bytes && bytes > 0 ? Math.round(bytes / GB) : fallback;
}

/**
 * Settings → Storage. Two jobs: let the user see what the app is actually
 * using on disk, and bound it.
 *
 * Downloaded checkpoints are kept so switching back to one is instant; past the
 * quota the least recently used are evicted. The shared base-component cache
 * (text encoders / VAEs) is deliberately NOT under that quota — those files are
 * shared by every checkpoint of a family, so evicting them automatically would
 * re-download 8–10 GB the next time any of them loads. It's purged by hand.
 */
export function StorageSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();

  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [models, setModels] = useState<CachedModel[]>([]);
  const [sizes, setSizes] = useState<FolderSizes | null>(null);
  const [busy, setBusy] = useState(false);

  // Cheap readout (index + one syscall): safe on every cache change.
  const refresh = useCallback(() => {
    void api.getStorageInfo().then(setInfo).catch(() => {});
    void api.listCachedModels().then(setModels).catch(() => {});
  }, []);

  // Expensive readout (three directory walks): fetched once per mount and after
  // a purge, never on every cache event.
  const refreshSizes = useCallback(() => {
    setSizes(null);
    void api.getFolderSizes().then(setSizes).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    refreshSizes();
    return api.onModelCacheChanged(refresh);
  }, [refresh, refreshSizes]);

  const quotaGB = toGB(draft.modelCacheQuotaBytes, toGB(info?.quotaBytes, 100));
  const minFreeGB = toGB(draft.modelCacheMinFreeBytes, toGB(info?.minFreeBytes, 10));
  const used = info?.usedBytes ?? 0;
  const quota = info?.quotaBytes ?? quotaGB * GB;
  const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;

  const deleteModel = async (m: CachedModel) => {
    const ok = await confirm({
      title: t("storage.deleteTitle"),
      description: t("storage.deleteConfirm", {
        name: m.modelName || m.modelCode || m.key,
        size: humanBytes(m.bytes),
      }),
      confirmLabel: t("storage.deleteAction"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteCachedModel(m.key);
      toast.toast(t("storage.deleted", { size: humanBytes(m.bytes) }));
      refreshSizes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const purgeBase = async () => {
    const ok = await confirm({
      title: t("storage.purgeTitle"),
      description: t("storage.purgeConfirm"),
      confirmLabel: t("storage.purgeAction"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.purgeBaseComponentsCache();
      toast.toast(t("storage.purged"));
      refreshSizes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      {/* Usage against the quota */}
      <section className="bg-card grid gap-3 rounded-2xl border p-4 shadow-sm">
        <div className="flex items-baseline justify-between gap-2">
          <Label>{t("storage.usageTitle")}</Label>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("storage.usageOf", { used: humanBytes(used), quota: humanBytes(quota) })}
          </span>
        </div>
        <ProgressBar percent={pct} className={cn(pct >= 90 && "opacity-90")} />
        <p className="text-muted-foreground text-xs">
          {t("storage.freeOnDisk", { free: humanBytes(info?.freeBytes ?? 0) })}
        </p>

        <div className="mt-1 grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="quota">{t("storage.quotaLabel")}</Label>
            <Input
              id="quota"
              type="number"
              min={MIN_QUOTA_GB}
              value={quotaGB}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  modelCacheQuotaBytes: Math.max(MIN_QUOTA_GB, Number(e.target.value) || 0) * GB,
                }))
              }
            />
            <p className="text-muted-foreground text-[11px]">{t("storage.quotaHint")}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="minfree">{t("storage.minFreeLabel")}</Label>
            <Input
              id="minfree"
              type="number"
              min={0}
              value={minFreeGB}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  modelCacheMinFreeBytes: Math.max(0, Number(e.target.value) || 0) * GB,
                }))
              }
            />
            <p className="text-muted-foreground text-[11px]">{t("storage.minFreeHint")}</p>
          </div>
        </div>
      </section>

      {/* Cached checkpoints */}
      <section className="bg-card grid gap-2 rounded-2xl border p-4 shadow-sm">
        <Label>{t("storage.modelsTitle")}</Label>
        <p className="text-muted-foreground text-xs">{t("storage.modelsHint")}</p>

        {models.length === 0 ? (
          <p className="text-muted-foreground py-3 text-center text-xs">{t("storage.modelsEmpty")}</p>
        ) : (
          <ul className="divide-border/60 mt-1 divide-y">
            {models.map((m) => (
              <li key={m.key} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-xs font-medium" title={m.key}>
                    {m.modelName || m.modelCode || m.key}
                    {m.active && (
                      <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">
                        {t("storage.badgeActive")}
                      </span>
                    )}
                    {m.orphan && (
                      <span
                        className="text-muted-foreground/70 inline-flex items-center gap-1 text-[10px]"
                        title={t("storage.orphanHint")}
                      >
                        <AlertTriangle className="size-3" />
                        {t("storage.badgeUnknown")}
                      </span>
                    )}
                  </p>
                  <p className="text-muted-foreground text-[11px] tabular-nums">
                    {humanBytes(m.bytes)} · {relativeTime(m.lastUsedAt, t)}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={m.active}
                  onClick={() => void deleteModel(m)}
                  aria-label={t("storage.deleteAction")}
                  title={m.active ? t("storage.deleteActiveBlocked") : t("storage.deleteAction")}
                  className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Folders on disk */}
      <section className="bg-card grid gap-2 rounded-2xl border p-4 shadow-sm">
        <Label>{t("storage.foldersTitle")}</Label>

        <FolderRow
          icon={<HardDrive className="size-3.5" />}
          name={t("storage.folderModels")}
          hint={t("storage.folderModelsHint")}
          path={info?.modelsDir}
          bytes={sizes?.modelsBytes}
          onOpen={() => void api.openCacheFolder("models").catch(() => {})}
        />
        <FolderRow
          icon={<HardDrive className="size-3.5" />}
          name={t("storage.folderBase")}
          hint={t("storage.folderBaseHint")}
          path={info?.baseCacheDir}
          bytes={sizes?.baseCacheBytes}
          onOpen={() => void api.openCacheFolder("base").catch(() => {})}
          action={
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void purgeBase()}>
              {t("storage.purgeAction")}
            </Button>
          }
        />
        <FolderRow
          icon={<HardDrive className="size-3.5" />}
          name={t("storage.folderEngine")}
          hint={t("storage.folderEngineHint")}
          path={info?.engineDir}
          bytes={sizes?.engineBytes}
          onOpen={() => void api.openCacheFolder("engine").catch(() => {})}
        />
      </section>
    </div>
  );
}

function FolderRow({
  icon,
  name,
  hint,
  path,
  bytes,
  onOpen,
  action,
}: {
  icon: React.ReactNode;
  name: string;
  hint: string;
  path?: string;
  /** undefined while the (slow) directory walk is still running. */
  bytes?: number;
  onOpen: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{name}</p>
        <p className="text-muted-foreground truncate text-[11px]" title={path}>
          {hint}
        </p>
      </div>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {bytes === undefined ? <Skeleton className="h-4 w-14" /> : humanBytes(bytes)}
      </span>
      {action}
      <button
        type="button"
        onClick={onOpen}
        aria-label={name}
        className="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded p-1.5 transition-colors"
      >
        <FolderOpen className="size-3.5" />
      </button>
    </div>
  );
}
