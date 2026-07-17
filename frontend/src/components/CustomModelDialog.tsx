import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileBox, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

type Backend = "sdxl" | "sd15" | "zimage" | "flux" | "chroma" | "qwenimage" | "anima";

// One row per image backend that can load a SINGLE .safetensors checkpoint.
// `base` (when set) is the shared base-components repo a transformer-only
// checkpoint needs — shown as the default placeholder and applied server-side
// when the user leaves the field blank (see cloud.DefaultBaseModel). Mirrors the
// Go IsSingleFileBackend / DefaultBaseModel set. Hints are i18n keys.
const BACKENDS: { id: Backend; label: string; hintKey: string; base?: string }[] = [
  { id: "sdxl", label: "SDXL", hintKey: "customModel.hintSdxl" },
  { id: "sd15", label: "SD 1.5", hintKey: "customModel.hintSd15" },
  { id: "zimage", label: "Z-Image", hintKey: "customModel.hintZimage", base: "Tongyi-MAI/Z-Image-Turbo" },
  { id: "flux", label: "FLUX", hintKey: "customModel.hintFlux", base: "black-forest-labs/FLUX.1-dev" },
  { id: "chroma", label: "Chroma", hintKey: "customModel.hintChroma", base: "lodestones/Chroma1-HD" },
  { id: "qwenimage", label: "Qwen-Image", hintKey: "customModel.hintQwenimage", base: "Qwen/Qwen-Image" },
  { id: "anima", label: "Anima", hintKey: "customModel.hintAnima", base: "circlestone-labs/Anima-Base-v1.0-Diffusers" },
];

type Props = {
  // Absolute path returned by the native picker; null closes the dialog.
  path: string | null;
  onClose: () => void;
  // Confirm: register + activate the checkpoint. Rejections show inline.
  onConfirm: (path: string, backend: Backend, baseModel: string) => Promise<void>;
};

// CustomModelDialog — second step of the "add custom model" flow: the file is
// already chosen, the user picks which engine backend should load it (and, for
// transformer-only backends, optionally overrides the base repo).
export function CustomModelDialog({ path, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const [backend, setBackend] = useState<Backend>("sdxl");
  const [baseModel, setBaseModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileName = path?.split(/[\\/]/).pop() ?? "";
  const selected = BACKENDS.find((b) => b.id === backend)!;

  const confirm = async () => {
    if (!path || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Empty base → server applies DefaultBaseModel for the backend.
      await onConfirm(path, backend, selected.base ? baseModel.trim() : "");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={path !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="space-y-1 text-left">
          <DialogTitle className="text-lg">{t("customModel.title")}</DialogTitle>
          <DialogDescription>{t("customModel.desc")}</DialogDescription>
        </DialogHeader>

        <div className="bg-muted/40 flex items-center gap-2.5 rounded-xl border px-3 py-2.5">
          <FileBox className="size-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{fileName}</p>
            <p className="text-muted-foreground truncate text-[11px]" title={path ?? ""}>
              {path}
            </p>
          </div>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="custom-backend" className="text-xs">
            {t("customModel.modelType")}
          </Label>
          <Select id="custom-backend" fullWidth value={backend} onChange={(v) => setBackend(v as Backend)}>
            {BACKENDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </Select>
          <p className="text-muted-foreground text-xs">{t(selected.hintKey)}</p>
        </div>

        {selected.base && (
          <div className="grid gap-2">
            <Label htmlFor="custom-base-model" className="text-xs">
              {t("customModel.baseModel")}
            </Label>
            <Input
              id="custom-base-model"
              value={baseModel}
              onChange={(e) => setBaseModel(e.target.value)}
              placeholder={selected.base}
            />
            <p className="text-muted-foreground text-[11px]">
              {t("customModel.baseModelHint", { base: selected.base })}
            </p>
          </div>
        )}

        {error && <p className="text-destructive text-xs leading-relaxed">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={busy} onClick={confirm}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t("customModel.use")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
