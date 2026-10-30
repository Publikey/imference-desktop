import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, HardDrive, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GALLERY_CHANGED_EVENT } from "@/lib/target";
import type { GalleryStatus } from "@/lib/web-gallery";

// Web build only: where the gallery is stored on the user's side. Lazily
// imports web-gallery so the desktop bundle never carries it.
const gallery = () => import("@/lib/web-gallery");

export function WebGallerySection() {
  const { t } = useTranslation();
  const [st, setSt] = useState<GalleryStatus | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    void gallery().then((g) => g.galleryStatus()).then(setSt);
  }, []);

  const act = (f: (g: typeof import("@/lib/web-gallery")) => Promise<GalleryStatus>) => async () => {
    setErr("");
    try {
      const g = await gallery();
      // No page reload: the gallery panel follows GALLERY_CHANGED_EVENT.
      setSt(await f(g));
    } catch (e: any) {
      if (e?.name !== "AbortError") setErr(String(e?.message || e));
    }
  };

  if (!st) return null;
  return (
    <div className="space-y-4">
      <div className="bg-card rounded-2xl border p-4 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium">
          {st.mode === "folder" ? <FolderOpen className="size-4" /> : <HardDrive className="size-4" />}
          {st.mode === "folder" ? t("web.gallery.folder", { name: st.folderName }) : t("web.gallery.browser")}
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          {st.mode === "folder" ? t("web.gallery.folderHint") : t("web.gallery.browserHint")}
        </p>
        {st.needsPermission && (
          <Button size="sm" className="mt-3 gap-1.5" onClick={act((g) => g.reconnectFolder())}>
            <RefreshCw className="size-3.5" />
            {t("web.gallery.reconnect")}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {st.folderSupported ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={act((g) => g.chooseFolder())}>
            <FolderOpen className="size-3.5" />
            {st.mode === "folder" ? t("web.gallery.changeFolder") : t("web.gallery.chooseFolder")}
          </Button>
        ) : (
          <p className="text-muted-foreground text-xs">{t("web.gallery.unsupported")}</p>
        )}
        {st.mode === "folder" && (
          <Button variant="ghost" size="sm" onClick={act((g) => g.useBrowserStorage())}>
            {t("web.gallery.useBrowser")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">{t("web.gallery.privacy")}</p>
      {err && <p className="text-destructive text-xs">{err}</p>}
    </div>
  );
}

/** Banner when the chosen folder needs the user's click to be readable again. */
export function WebGalleryBanner() {
  const { t } = useTranslation();
  const [need, setNeed] = useState(false);
  useEffect(() => {
    const check = () =>
      void gallery()
        .then((g) => g.galleryStatus())
        .then((s) => setNeed(s.needsPermission));
    check();
    // Access granted (here or in Settings) → the banner goes away.
    window.addEventListener(GALLERY_CHANGED_EVENT, check);
    return () => window.removeEventListener(GALLERY_CHANGED_EVENT, check);
  }, []);
  if (!need) return null;
  return (
    <div className="bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100 flex flex-wrap items-center justify-center gap-3 border-b px-4 py-2 text-sm">
      <span>{t("web.gallery.bannerText")}</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        onClick={async () => {
          const g = await gallery();
          setNeed((await g.reconnectFolder()).needsPermission);
        }}
      >
        {t("web.gallery.reconnect")}
      </Button>
    </div>
  );
}
