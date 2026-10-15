// Settings → Editing tools: where tools run by default, their device, the idle
// shutdown of the tools engine, and the local API agents (the MCP server's
// run_on: local) use. Edits the settings draft — the dialog auto-saves it and
// the Go side applies the change (SaveSettings).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/lib/wails-bridge";
import type { AppSettings, LocalApiInfo, ToolsSettings } from "@/lib/types";

export function ToolsSection({
  draft,
  setDraft,
}: {
  draft: AppSettings;
  setDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
}) {
  const { t } = useTranslation();
  const ts: ToolsSettings = draft.tools ?? {};
  const set = (patch: Partial<ToolsSettings>) =>
    setDraft((d) => ({ ...d, tools: { ...(d.tools ?? {}), ...patch } }));

  // The API state follows the toggle after the auto-save lands.
  const [info, setInfo] = useState<LocalApiInfo | null>(null);
  useEffect(() => {
    const id = window.setTimeout(() => {
      void api.getLocalApiInfo().then(setInfo).catch(() => {});
    }, 700);
    return () => window.clearTimeout(id);
  }, [ts.localApiDisabled]);

  return (
    <div className="space-y-4">
      {/* Where tools run follows the app's global mode (Engine panel). */}

      <div className="bg-card grid gap-4 rounded-2xl border p-4 shadow-sm sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="tools-device" className="text-xs">
            {t("tools.settings.device")}
          </Label>
          <Select id="tools-device" fullWidth value={ts.device ?? ""} onChange={(v) => set({ device: v || undefined })}>
            <option value="">{t("tools.settings.deviceAuto")}</option>
            <option value="cpu">CPU</option>
            <option value="cuda">CUDA (NVIDIA)</option>
            <option value="directml">DirectML (Windows)</option>
            <option value="rocm">ROCm (AMD)</option>
            <option value="mps">Core ML (Apple)</option>
          </Select>
          <p className="text-muted-foreground text-[11px]">{t("tools.settings.deviceHint")}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="tools-idle" className="text-xs">
            {t("tools.settings.idle")}
          </Label>
          <Select
            id="tools-idle"
            fullWidth
            value={String(ts.idleMinutes ?? 0)}
            onChange={(v) => set({ idleMinutes: Number(v) || undefined })}
          >
            {[0, 2, 5, 30, 60].map((m) => (
              <option key={m} value={String(m)}>
                {m === 0 ? t("tools.settings.idleDefault") : t("tools.settings.idleMinutes", { count: m })}
              </option>
            ))}
          </Select>
          <p className="text-muted-foreground text-[11px]">{t("tools.settings.idleHint")}</p>
        </div>
      </div>

      <div className="bg-card grid gap-2 rounded-2xl border p-4 shadow-sm">
        <label className="flex items-center gap-2.5 text-sm font-medium">
          <Checkbox checked={!ts.localApiDisabled} onCheckedChange={(on) => set({ localApiDisabled: !on || undefined })} />
          <Bot className="text-muted-foreground size-4" />
          {t("tools.settings.api")}
        </label>
        <p className="text-muted-foreground text-xs leading-relaxed">{t("tools.settings.apiHint")}</p>
        {info && (
          <p className="text-muted-foreground font-mono text-[11px] break-all">
            {info.running
              ? t("tools.settings.apiRunning", { port: info.port, path: info.discoveryPath })
              : t("tools.settings.apiStopped")}
          </p>
        )}
      </div>
    </div>
  );
}
