import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
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


export function EngineRuntimeSection({
  value,
  onChange,
}: {
  value?: EngineRuntimeSettings;
  onChange: (next: EngineRuntimeSettings) => void;
}) {
  const { t } = useTranslation();
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
        <h3 className="text-sm font-semibold">{t("runtime.title")}</h3>
        <p className="text-muted-foreground text-[11px]">{t("runtime.desc")}</p>
      </div>

      {/* Image — one block for every image backend (SDXL, SD 1.5, Z-Image,
          FLUX, Chroma, Qwen-Image, Anima); they share the IMAGE_* contract. */}
      <div id="settings-runtime-image" className="grid gap-3 scroll-mt-4">
        <span className="text-xs font-medium">
          {t("runtime.image")}{" "}
          <span className="text-muted-foreground font-normal">{t("runtime.imageModels")}</span>
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
          label={t("runtime.tinyVae")}
        />
        <OffloadSelect
          value={image.enableCpuOffload}
          onChange={(enableCpuOffload) => setImage({ enableCpuOffload })}
        />
      </div>

      {/* WAN video — applies once the video backend is enabled */}
      <div id="settings-runtime-wan" className="grid gap-3 border-t pt-3 scroll-mt-4">
        <span className="text-xs font-medium">
          {t("runtime.videoWan")}{" "}
          <span className="text-muted-foreground font-normal">{t("runtime.wanApplies")}</span>
        </span>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-xs">
            {t("runtime.device")}
            <Select fullWidth value={wan.device || "auto"} onChange={(v) => setWan({ device: v })}>
              <option value="auto">{t("runtime.auto")}</option>
              <option value="cuda">{t("runtime.cuda")}</option>
              <option value="cpu">{t("runtime.cpu")}</option>
            </Select>
          </label>
          <label className="grid gap-1 text-xs">
            {t("runtime.quant")}
            <Select fullWidth value={wan.memoryProfile || "auto"} onChange={(v) => setWan({ memoryProfile: v })}>
              <option value="auto">{t("runtime.quantAuto")}</option>
              <option value="gguf_q8">{t("runtime.q8")}</option>
              <option value="gguf_q6">{t("runtime.q6")}</option>
              <option value="gguf_q5">{t("runtime.q5")}</option>
              <option value="gguf_q4">{t("runtime.q4")}</option>
            </Select>
          </label>
          <label className="grid gap-1 text-xs">
            {t("runtime.textEncoderQuant")}
            <Select fullWidth value={wan.textEncoderQuant || "int8"} onChange={(v) => setWan({ textEncoderQuant: v })}>
              <option value="int8">{t("runtime.int8")}</option>
              <option value="none">{t("runtime.noneBf16")}</option>
            </Select>
          </label>
          <label className="grid gap-1 text-xs">
            {t("runtime.maxResident")}
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
          label={t("runtime.vaeTiling")}
        />
        <Toggle
          checked={wan.enableOffload !== false}
          onChange={(enableOffload) => setWan({ enableOffload })}
          label={t("runtime.cpuOffloadVideo")}
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
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="grid gap-1 text-xs">
        {t("runtime.device")}
        <Select fullWidth value={device || "auto"} onChange={onDevice}>
          <option value="auto">{t("runtime.auto")}</option>
          <option value="cuda">{t("runtime.cuda")}</option>
          <option value="cpu">{t("runtime.cpu")}</option>
          {mps && <option value="mps">{t("runtime.mps")}</option>}
        </Select>
      </label>
      <label className="grid gap-1 text-xs">
        {t("runtime.maxGpuModels")}
        <Input value={maxGpuModels ?? ""} onChange={(e) => onMaxGpu(e.target.value)} placeholder="auto" />
      </label>
      <label className="grid gap-1 text-xs">
        {t("runtime.maxCpuModels")}
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
  const { t } = useTranslation();
  const current = value === undefined ? "auto" : value ? "on" : "off";
  return (
    <label className="grid gap-1 text-xs">
      {t("runtime.cpuOffload")}
      <Select
        fullWidth
        value={current}
        onChange={(v) => onChange(v === "auto" ? undefined : v === "on")}
      >
        <option value="auto">{t("runtime.offloadAuto")}</option>
        <option value="on">{t("runtime.offloadOn")}</option>
        <option value="off">{t("runtime.offloadOff")}</option>
      </Select>
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
    <label className="flex cursor-pointer items-center gap-2 text-xs">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}
