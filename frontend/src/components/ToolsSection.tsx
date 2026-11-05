// Settings → Editing tools: the device tools run on and the idle shutdown of
// the tools engine (the agents' local API is in Settings › AI agents). Edits
// the settings draft — the dialog auto-saves it and the Go side applies the
// change (SaveSettings).
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { AppSettings, ToolsSettings } from "@/lib/types";

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

  return (
    <div className="space-y-4">
      {/* Where tools run follows the app's global mode (header switch). */}

      <div className="ds-card grid gap-4 p-4 sm:grid-cols-2">
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
          <p className="text-muted-foreground text-2xs">{t("tools.settings.deviceHint")}</p>
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
          <p className="text-muted-foreground text-2xs">{t("tools.settings.idleHint")}</p>
        </div>
      </div>
    </div>
  );
}
