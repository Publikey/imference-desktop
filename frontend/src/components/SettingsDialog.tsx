import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LocalEngineSection } from "@/components/LocalEngineSection";
import { api } from "@/lib/wails-bridge";
import type { AppSettings } from "@/lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: AppSettings) => void;
};

export function SettingsDialog({ open, onOpenChange, onSaved }: Props) {
  const [draft, setDraft] = useState<AppSettings>({
    apiKey: "",
    pythonPath: "",
    sdxlPath: "",
    cloudModel: "",
    outputDir: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void api.getSettings().then(setDraft);
  }, [open]);

  // LocalEngineSection auto-fills pythonPath via the Go side on successful
  // install; pull the new value into our draft so the field reflects reality
  // without the user needing to close+reopen the dialog.
  const handleInstallDone = useCallback(() => {
    void api.getSettings().then(setDraft);
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const next = await api.saveSettings(draft);
      onSaved(next);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Required for cloud and local generation. Saved to settings.json in your OS config dir.
          </DialogDescription>
        </DialogHeader>

        <LocalEngineSection onInstallDone={handleInstallDone} />

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="apiKey">Imference API key</Label>
            <Input
              id="apiKey"
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              placeholder="Bearer token from imference.com"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="cloudModel">Cloud model_code</Label>
            <Input
              id="cloudModel"
              value={draft.cloudModel}
              onChange={(e) => setDraft({ ...draft, cloudModel: e.target.value })}
              placeholder="e.g. sdxl-base"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="pythonPath">
              Python path
              <span className="text-muted-foreground font-normal">
                (auto-filled by Install — override here only if you want a custom venv)
              </span>
            </Label>
            <Input
              id="pythonPath"
              value={draft.pythonPath}
              onChange={(e) => setDraft({ ...draft, pythonPath: e.target.value })}
              placeholder="C:\Users\<you>\AppData\Local\imference-desktop-go\engine-venv\Scripts\python.exe"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="sdxlPath">Local SDXL .safetensors</Label>
            <Input
              id="sdxlPath"
              value={draft.sdxlPath}
              onChange={(e) => setDraft({ ...draft, sdxlPath: e.target.value })}
              placeholder="C:\models\sdxl_base.safetensors"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="outputDir">Auto-save folder (optional)</Label>
            <Input
              id="outputDir"
              value={draft.outputDir}
              onChange={(e) => setDraft({ ...draft, outputDir: e.target.value })}
              placeholder="Leave empty to use ~/Pictures/Imference"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
