import { useState } from "react";
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

type Backend = "sdxl" | "zimage";

type Props = {
  // Absolute path returned by the native picker; null closes the dialog.
  path: string | null;
  onClose: () => void;
  // Confirm: register + activate the checkpoint. Rejections show inline.
  onConfirm: (path: string, backend: Backend, baseModel: string) => Promise<void>;
};

// CustomModelDialog — second step of the "add custom model" flow: the file is
// already chosen, the user only picks which engine backend should load it
// (Z-Image finetunes additionally need their Hugging Face base repo).
export function CustomModelDialog({ path, onClose, onConfirm }: Props) {
  const [backend, setBackend] = useState<Backend>("sdxl");
  const [baseModel, setBaseModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileName = path?.split(/[\\/]/).pop() ?? "";

  const confirm = async () => {
    if (!path || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(path, backend, backend === "zimage" ? baseModel : "");
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
          <DialogTitle className="text-lg">Add custom model</DialogTitle>
          <DialogDescription>
            The file stays where it is — nothing is copied or uploaded.
          </DialogDescription>
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
          <Label className="text-xs">Model type</Label>
          <div className="flex flex-col gap-2 text-sm">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="custom-backend"
                checked={backend === "sdxl"}
                onChange={() => setBackend("sdxl")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">SDXL checkpoint</span>
                <span className="text-muted-foreground block text-xs">
                  Most Civitai models (SDXL, Pony, Illustrious…) — a single self-contained file.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="custom-backend"
                checked={backend === "zimage"}
                onChange={() => setBackend("zimage")}
                className="mt-1"
              />
              <span>
                <span className="font-medium">Z-Image finetune</span>
                <span className="text-muted-foreground block text-xs">
                  Transformer-only weights that need their base model downloaded alongside.
                </span>
              </span>
            </label>
          </div>
        </div>

        {backend === "zimage" && (
          <div className="grid gap-2">
            <Label htmlFor="custom-base-model" className="text-xs">
              Base model (Hugging Face repo id)
            </Label>
            <Input
              id="custom-base-model"
              value={baseModel}
              onChange={(e) => setBaseModel(e.target.value)}
              placeholder="Tongyi-MAI/Z-Image-Turbo"
            />
          </div>
        )}

        {error && <p className="text-destructive text-xs leading-relaxed">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || (backend === "zimage" && !baseModel.trim())} onClick={confirm}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Use this model
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
