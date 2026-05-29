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
import { ModelPicker } from "@/components/ModelPicker";
import { WalletSection } from "@/components/WalletSection";
import { api } from "@/lib/wails-bridge";
import type { AppSettings, PaymentMode } from "@/lib/types";

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
    paymentMode: "bearer",
    walletAddress: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void api.getSettings().then(setDraft);
  }, [open]);

  // Both LocalEngineSection (install) and ModelPicker (model switch) mutate
  // settings server-side directly (pythonPath/sdxlPath/localModel), bypassing
  // this dialog's Save button. Refetch into our draft AND push up to the parent
  // via onSaved so App's generation params (steps/cfg from the selected model)
  // stay in sync without the user clicking Save or reopening the dialog.
  const handleInstallDone = useCallback(() => {
    void api.getSettings().then((next) => {
      setDraft(next);
      onSaved(next);
    });
  }, [onSaved]);

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

        <ModelPicker
          activeModelCode={draft.localModel?.modelCode ?? null}
          onModelSelected={handleInstallDone}
        />

        <section className="border-border rounded-lg border p-4">
          <h3 className="mb-3 text-sm font-semibold">Cloud payment</h3>
          <div className="mb-4 grid gap-2">
            <Label className="text-xs">Mode</Label>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="paymentMode"
                  value="bearer"
                  checked={draft.paymentMode !== "x402"}
                  onChange={() => setDraft({ ...draft, paymentMode: "bearer" as PaymentMode })}
                />
                API key (credit)
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="paymentMode"
                  value="x402"
                  checked={draft.paymentMode === "x402"}
                  onChange={() => setDraft({ ...draft, paymentMode: "x402" as PaymentMode })}
                />
                x402 (USDC wallet)
              </label>
            </div>
          </div>

          {draft.paymentMode !== "x402" && (
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
          )}

          {draft.paymentMode === "x402" && (
            <WalletSection
              onChanged={(newAddress) => {
                // Surgical merge: only walletAddress changes. A full
                // settings refetch would clobber unsaved draft fields
                // like paymentMode (the radio above).
                setDraft((prev) => ({ ...prev, walletAddress: newAddress }));
              }}
            />
          )}
        </section>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="cloudModel">Cloud model_code</Label>
            <Input
              id="cloudModel"
              value={draft.cloudModel}
              onChange={(e) => setDraft({ ...draft, cloudModel: e.target.value })}
              placeholder="e.g. sdxl-base or anime-v1"
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
