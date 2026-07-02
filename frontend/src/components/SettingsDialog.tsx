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
import { WalletSection } from "@/components/WalletSection";
import { EngineRuntimeSection } from "@/components/EngineRuntimeSection";
import { api } from "@/lib/wails-bridge";
import type { AppSettings, EngineRuntimeSettings, PaymentMode } from "@/lib/types";

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
    engineRuntime: { sdxl: {}, zimage: {}, wan: {} },
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void api.getSettings().then(setDraft);
  }, [open]);

  // LocalEngineSection (install) mutates settings server-side directly
  // (pythonPath), bypassing this dialog's Save button. Refetch into our draft
  // AND push up to the parent via onSaved so the app stays in sync without the
  // user clicking Save or reopening the dialog.
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
      <DialogContent className="max-h-[90vh] overflow-y-auto rounded-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Required for cloud and local generation. Saved to settings.json in your OS config dir.
          </DialogDescription>
        </DialogHeader>

        <LocalEngineSection onInstallDone={handleInstallDone} />

        <EngineRuntimeSection
          value={draft.engineRuntime}
          onChange={(next: EngineRuntimeSettings) =>
            setDraft((d) => ({ ...d, engineRuntime: next }))
          }
        />

        <section className="bg-card rounded-2xl border p-4 shadow-sm">
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

        <section className="bg-card grid gap-4 rounded-2xl border p-4 shadow-sm">
          <h3 className="text-sm font-semibold">Paths</h3>
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
              placeholder="~/Library/Caches/imference-desktop-go/engine-venv/bin/python"
            />
          </div>

          {/* The local model's .safetensors path is managed automatically by the
              model dropdown (download on Run) — not a user-facing setting. */}

          <div className="grid gap-2">
            <Label htmlFor="outputDir">Auto-save folder (optional)</Label>
            <Input
              id="outputDir"
              value={draft.outputDir}
              onChange={(e) => setDraft({ ...draft, outputDir: e.target.value })}
              placeholder="Leave empty to use ~/Pictures/Imference"
            />
          </div>
        </section>

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
