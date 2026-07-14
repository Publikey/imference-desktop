import { Input } from "@/components/ui/input";
import type {
  EngineRuntimeSettings,
  ImageRuntimeSettings,
  WanRuntimeSettings,
} from "@/lib/types";

// Host-machine tuning for the engine — NOT generation params (those live in the
// generation UI). Maps to the engine's RuntimeConfig / WanRuntimeConfig env
// contract (IMAGE_* / WAN_*). All image backends (SDXL, SD 1.5, Z-Image, FLUX,
// Chroma, Qwen-Image, Anima) share ONE Image block — they share the engine's
// IMAGE_* contract and only one loads per sidecar. Empty / "auto" = "let the
// engine adapt". Saving restarts the local engine (load-time knobs).

const EMPTY: EngineRuntimeSettings = { image: {}, wan: {} };

const selectCls = "border-input bg-background h-9 rounded-md border px-2 text-sm";

export function EngineRuntimeSection({
  value,
  onChange,
}: {
  value?: EngineRuntimeSettings;
  onChange: (next: EngineRuntimeSettings) => void;
}) {
  const v = value ?? EMPTY;
  const image = v.image ?? {};
  const wan = v.wan ?? {};
  const setImage = (patch: Partial<ImageRuntimeSettings>) =>
    onChange({ image: { ...image, ...patch }, wan });
  const setWan = (patch: Partial<WanRuntimeSettings>) =>
    onChange({ image, wan: { ...wan, ...patch } });

  return (
    <section className="bg-card grid gap-4 rounded-2xl border p-4 shadow-sm">
      <div>
        <h3 className="text-sm font-semibold">Engine / machine</h3>
        <p className="text-muted-foreground text-[11px]">
          How each engine runs on your machine. Defaults adapt automatically — change these only to
          fit your GPU/RAM. Saving restarts the local engine.
        </p>
      </div>

      {/* Image — one block for every image backend (SDXL, SD 1.5, Z-Image,
          FLUX, Chroma, Qwen-Image, Anima); they share the IMAGE_* contract. */}
      <div id="settings-runtime-image" className="grid gap-3 scroll-mt-4">
        <span className="text-xs font-medium">
          Image{" "}
          <span className="text-muted-foreground font-normal">
            — SDXL · SD 1.5 · Z-Image · FLUX · Chroma · Qwen-Image · Anima
          </span>
        </span>
        <DeviceMaxGrid
          device={image.device}
          maxGpuModels={image.maxGpuModels}
          maxCpuModels={image.maxCpuModels}
          onDevice={(device) => setImage({ device })}
          onMaxGpu={(maxGpuModels) => setImage({ maxGpuModels })}
          onMaxCpu={(maxCpuModels) => setImage({ maxCpuModels })}
          mps
        />
        <Toggle
          checked={!!image.useTinyVae}
          onChange={(useTinyVae) => setImage({ useTinyVae })}
          label="Tiny VAE — much faster decode, slight quality loss (SDXL / SD 1.5 only)"
        />
        <OffloadSelect
          value={image.enableCpuOffload}
          onChange={(enableCpuOffload) => setImage({ enableCpuOffload })}
        />
      </div>

      {/* WAN video — applies once the video backend is enabled */}
      <div id="settings-runtime-wan" className="grid gap-3 border-t pt-3 scroll-mt-4">
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

// CPU offload is tri-state. Auto (undefined) lets the desktop enable offload on
// small-VRAM GPUs, where keeping the whole pipe resident oversubscribes VRAM and
// spills to shared system memory (~50× slower); On/Off force it. Maps to the Go
// *bool ImageRuntimeSettings.EnableCPUOffload (nil = Auto).
function OffloadSelect({
  value,
  onChange,
}: {
  value?: boolean;
  onChange: (v: boolean | undefined) => void;
}) {
  const current = value === undefined ? "auto" : value ? "on" : "off";
  return (
    <label className="grid gap-1 text-xs">
      CPU offload
      <select
        className={selectCls}
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "auto" ? undefined : v === "on");
        }}
      >
        <option value="auto">Auto — enabled on low-VRAM GPUs (recommended)</option>
        <option value="on">On — always (lowest peak VRAM)</option>
        <option value="off">Off — full residency (needs ≳ 12 GB VRAM)</option>
      </select>
    </label>
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
