import { Input } from "@/components/ui/input";
import type {
  EngineRuntimeSettings,
  ImageRuntimeSettings,
  WanRuntimeSettings,
  ZImageRuntimeSettings,
} from "@/lib/types";

// Host-machine tuning for the engine — NOT generation params (those live in the
// generation UI). Maps to the engine's RuntimeConfig / WanRuntimeConfig env
// contract (IMAGE_* / WAN_*). SDXL and Z-Image each get their own block: only
// one image backend loads per sidecar, so the desktop applies the block matching
// the selected model's engine. Empty / "auto" = "let the engine adapt". Saving
// restarts the local engine (load-time knobs).

const EMPTY: EngineRuntimeSettings = { sdxl: {}, zimage: {}, wan: {} };

const selectCls = "border-input bg-background h-9 rounded-md border px-2 text-sm";

export function EngineRuntimeSection({
  value,
  onChange,
}: {
  value?: EngineRuntimeSettings;
  onChange: (next: EngineRuntimeSettings) => void;
}) {
  const v = value ?? EMPTY;
  const sdxl = v.sdxl ?? {};
  const zimage = v.zimage ?? {};
  const wan = v.wan ?? {};
  const setSdxl = (patch: Partial<ImageRuntimeSettings>) =>
    onChange({ sdxl: { ...sdxl, ...patch }, zimage, wan });
  const setZimage = (patch: Partial<ZImageRuntimeSettings>) =>
    onChange({ sdxl, zimage: { ...zimage, ...patch }, wan });
  const setWan = (patch: Partial<WanRuntimeSettings>) =>
    onChange({ sdxl, zimage, wan: { ...wan, ...patch } });

  return (
    <section className="bg-card grid gap-4 rounded-2xl border p-4 shadow-sm">
      <div>
        <h3 className="text-sm font-semibold">Engine / machine</h3>
        <p className="text-muted-foreground text-[11px]">
          How each engine runs on your machine. Defaults adapt automatically — change these only to
          fit your GPU/RAM. Saving restarts the local engine.
        </p>
      </div>

      {/* SDXL */}
      <div className="grid gap-3">
        <span className="text-xs font-medium">SDXL</span>
        <DeviceMaxGrid
          device={sdxl.device}
          maxGpuModels={sdxl.maxGpuModels}
          maxCpuModels={sdxl.maxCpuModels}
          onDevice={(device) => setSdxl({ device })}
          onMaxGpu={(maxGpuModels) => setSdxl({ maxGpuModels })}
          onMaxCpu={(maxCpuModels) => setSdxl({ maxCpuModels })}
          mps
        />
        <Toggle
          checked={!!sdxl.useTinyVae}
          onChange={(useTinyVae) => setSdxl({ useTinyVae })}
          label="Tiny VAE — much faster decode, slight quality loss"
        />
        <Toggle
          checked={!!sdxl.enableCpuOffload}
          onChange={(enableCpuOffload) => setSdxl({ enableCpuOffload })}
          label="CPU offload — lower VRAM (≤ 8 GB), a bit slower"
        />
      </div>

      {/* Z-Image — no Tiny VAE (SDXL-only, ignored by Z-Image) */}
      <div className="grid gap-3 border-t pt-3">
        <span className="text-xs font-medium">Z-Image</span>
        <DeviceMaxGrid
          device={zimage.device}
          maxGpuModels={zimage.maxGpuModels}
          maxCpuModels={zimage.maxCpuModels}
          onDevice={(device) => setZimage({ device })}
          onMaxGpu={(maxGpuModels) => setZimage({ maxGpuModels })}
          onMaxCpu={(maxCpuModels) => setZimage({ maxCpuModels })}
          mps
        />
        <Toggle
          checked={!!zimage.enableCpuOffload}
          onChange={(enableCpuOffload) => setZimage({ enableCpuOffload })}
          label="CPU offload — lower VRAM (≤ 8 GB), a bit slower"
        />
      </div>

      {/* WAN video — applies once the video backend is enabled */}
      <div className="grid gap-3 border-t pt-3">
        <span className="text-xs font-medium">
          Video · WAN{" "}
          <span className="text-muted-foreground font-normal">— applies once video is enabled</span>
        </span>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-xs">
            Device
            <select
              className={selectCls}
              value={wan.device || "auto"}
              onChange={(e) => setWan({ device: e.target.value })}
            >
              <option value="auto">Auto</option>
              <option value="cuda">CUDA (GPU)</option>
              <option value="cpu">CPU</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Quantization (GGUF)
            <select
              className={selectCls}
              value={wan.memoryProfile || "auto"}
              onChange={(e) => setWan({ memoryProfile: e.target.value })}
            >
              <option value="auto">Auto (by VRAM)</option>
              <option value="gguf_q8">Q8 — best, ≥ 20 GB</option>
              <option value="gguf_q6">Q6 — ≥ 14 GB</option>
              <option value="gguf_q5">Q5</option>
              <option value="gguf_q4">Q4 — tightest cards</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Text-encoder quant
            <select
              className={selectCls}
              value={wan.textEncoderQuant || "int8"}
              onChange={(e) => setWan({ textEncoderQuant: e.target.value })}
            >
              <option value="int8">int8 — saves RAM</option>
              <option value="none">none — bf16</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Max resident variants
            <Input
              value={wan.maxResident ?? ""}
              onChange={(e) => setWan({ maxResident: e.target.value })}
              placeholder="1"
            />
          </label>
        </div>
        <Toggle
          checked={wan.vaeTiling !== false}
          onChange={(vaeTiling) => setWan({ vaeTiling })}
          label="VAE tiling — lower decode VRAM for long / large video"
        />
        <Toggle
          checked={wan.enableOffload !== false}
          onChange={(enableOffload) => setWan({ enableOffload })}
          label="CPU offload (video)"
        />
      </div>
    </section>
  );
}

// Shared device + residency-cap row for the image backends.
function DeviceMaxGrid({
  device,
  maxGpuModels,
  maxCpuModels,
  onDevice,
  onMaxGpu,
  onMaxCpu,
  mps,
}: {
  device?: string;
  maxGpuModels?: string;
  maxCpuModels?: string;
  onDevice: (v: string) => void;
  onMaxGpu: (v: string) => void;
  onMaxCpu: (v: string) => void;
  mps?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="grid gap-1 text-xs">
        Device
        <select className={selectCls} value={device || "auto"} onChange={(e) => onDevice(e.target.value)}>
          <option value="auto">Auto</option>
          <option value="cuda">CUDA (GPU)</option>
          <option value="cpu">CPU</option>
          {mps && <option value="mps">Apple MPS</option>}
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        Max GPU models
        <Input value={maxGpuModels ?? ""} onChange={(e) => onMaxGpu(e.target.value)} placeholder="auto" />
      </label>
      <label className="grid gap-1 text-xs">
        Max CPU-cached models
        <Input value={maxCpuModels ?? ""} onChange={(e) => onMaxCpu(e.target.value)} placeholder="auto" />
      </label>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
