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

type Backend = "sdxl" | "sd15" | "zimage" | "flux" | "chroma" | "qwenimage" | "anima";

// One row per image backend that can load a SINGLE .safetensors checkpoint.
// `base` (when set) is the shared base-components repo a transformer-only
// checkpoint needs — shown as the default placeholder and applied server-side
// when the user leaves the field blank (see cloud.DefaultBaseModel). Mirrors the
// Go IsSingleFileBackend / DefaultBaseModel set.
const BACKENDS: { id: Backend; label: string; hint: string; base?: string }[] = [
  { id: "sdxl", label: "SDXL", hint: "Most Civitai models (SDXL, Pony, Illustrious…) — a single self-contained file." },
  { id: "sd15", label: "SD 1.5", hint: "Classic Stable Diffusion 1.5 checkpoints — a single self-contained file." },
  { id: "zimage", label: "Z-Image", hint: "Transformer-only weights; needs a base repo.", base: "Tongyi-MAI/Z-Image-Turbo" },
  { id: "flux", label: "FLUX", hint: "FLUX.1 transformer-only checkpoint; needs a base repo.", base: "black-forest-labs/FLUX.1-dev" },
  { id: "chroma", label: "Chroma", hint: "FLUX-derived (single T5 encoder); needs a base repo.", base: "lodestones/Chroma1-HD" },
  { id: "qwenimage", label: "Qwen-Image", hint: "20B MMDiT, strong text rendering; needs a base repo.", base: "Qwen/Qwen-Image" },
  { id: "anima", label: "Anima", hint: "Single-file DiT (Cosmos); needs the Anima base repo (Qwen3 encoder + VAE).", base: "circlestone-labs/Anima-Base-v1.0-Diffusers" },
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
          <Label htmlFor="custom-backend" className="text-xs">
            Model type
          </Label>
          <select
            id="custom-backend"
            value={backend}
            onChange={(e) => setBackend(e.target.value as Backend)}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          >
            {BACKENDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">{selected.hint}</p>
        </div>

        {selected.base && (
          <div className="grid gap-2">
            <Label htmlFor="custom-base-model" className="text-xs">
              Base model (Hugging Face repo id) — optional
            </Label>
            <Input
              id="custom-base-model"
              value={baseModel}
              onChange={(e) => setBaseModel(e.target.value)}
              placeholder={selected.base}
            />
            <p className="text-muted-foreground text-[11px]">
              Leave blank to use the default ({selected.base}).
            </p>
          </div>
        )}

        {error && <p className="text-destructive text-xs leading-relaxed">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={confirm}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Use this model
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
