// ToolEditor — the Edit panel: runs editing tools on a gallery item (as Activity jobs).
//
// The form is generated from the tool's manifest params (enum -> segmented /
// select, bounded numbers -> slider, bool -> checkbox, string -> input), plus a
// custom UI where the manifest's plain fields would be unusable: the mask
// editor (magic eraser / inpaint / click-to-select) and the outpaint frame.
//
// Before running it says WHERE the tool runs (this computer, or the cloud with
// the upload notice and the price); while running it names the stage (never an
// opaque "generating"); after, it previews the result with a before/after
// toggle and offers Open / Use as source / Reveal and chaining another tool on
// the result. A local failure the cloud can fix (out of memory, missing runtime)
// is answered with a priced "Run in the cloud?" proposal — never a silent switch.
// Closing releases the tools' warm models.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Download,
  Cloud,
  Cpu,
  ChevronDown,
  FolderOpen,
  ImagePlus,
  Images,
  Loader2,
  Play,
  ShieldAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import { ProgressBar } from "@/components/ui/progress";
import { MaskEditor, type MaskEditorHandle, type MaskMode } from "@/components/MaskEditor";
import { CropFrame } from "@/components/CropFrame";
import { ToolBadgeChip, ToolIcon, formatToolPrice, toolName, usePaymentRail } from "@/components/ToolBits";
import { api } from "@/lib/wails-bridge";
import {
  EDIT_TOOL_IDS,
  HIDDEN_PARAMS,
  INSTRUCT_EDIT_ID,
  UTILITY_TOOL_IDS,
  VIDEO_TOOL_IDS,
  coerceParam,
  defaultParams,
  newToolJobId,
  refreshTools,
  toolById,
  useTools,
} from "@/lib/tools";
import { cn } from "@/lib/utils";
import { isWeb } from "@/lib/target";
import type {
  EditModelsInfo,
  GenToolModels,
  GenerationMeta,
  InstallProgress,
  ModelInfo,
  SavedImage,
  ToolError,
  ToolInfo,
  ToolParamSpec,
  Job,
  ToolRunRequest,
  ToolsMode,
} from "@/lib/types";

/** The item a tool runs on. */
export type ToolSource = {
  /** Gallery file name (null for an unsaved image: its bytes are sent instead). */
  name: string | null;
  kind?: string;
  meta?: GenerationMeta | null;
  getSrc: () => Promise<string>;
};

type Phase = "form" | "running" | "done" | "error";

/** A reference image of "Edit with instructions": the input sent to the tool
 *  (gallery name or data: URI) and its preview. */
type RefImage = { input: string; preview: string; label: string };

const MASK_TOOLS = ["erase-object", "inpaint"] as const;

function isVideo(src: string | null | undefined): boolean {
  return !!src && src.startsWith("data:video/");
}

/**
 * The image editor (the main window's Edit panel): the source image / mask
 * editor, a tool and its settings. A run is an Activity job (onRunJob): the
 * panel never blocks, the job keeps going while the user edits, generates or
 * closes the panel, and its outputs land in the gallery.
 */
export function ToolEditor({
  toolId,
  source,
  initialMaskMode,
  jobs,
  onClose,
  onRunJob,
}: {
  toolId: string;
  source: ToolSource;
  /** "select" when opened from "Click to select". */
  initialMaskMode?: MaskMode;
  /** The Activity jobs (this editor follows the last one it started). */
  jobs: Job[];
  onClose: () => void;
  /** Start a run as an Activity job (App.runToolJob). */
  onRunJob: (req: ToolRunRequest, label: string, sourceName: string | null) => void;
}) {
  const open = true;
  const { t } = useTranslation();
  const tools = useTools();
  const rail = usePaymentRail();
  const [currentId, setCurrentId] = useState(toolId);
  const [src, setSrc] = useState<ToolSource>(source);
  const tool = toolById(tools, currentId);

  const [srcData, setSrcData] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  // Where a run goes: Local or Cloud, nothing in between. Preselected from the
  // Settings preference; "Automatic" there picks Local when this machine can
  // run the tool, else Cloud. A click here overrides it for this tool.
  const [runPref, setRunPref] = useState<ToolsMode>("auto");
  const [runPick, setRunPick] = useState<"local" | "cloud" | null>(null);
  // A run refused before it started (empty mask, a click-to-select error).
  const [formError, setFormError] = useState<ToolError | null>(null);
  const [hasMask, setHasMask] = useState(false);
  // "Download model": a local run never starts a weights download by itself
  // (same rule as the Create panel); the button fetches them explicitly.
  const [weightsDl, setWeightsDl] = useState<{ percent: number; error?: string } | null>(null);
  useEffect(
    () =>
      api.onToolWeights((p) => {
        if (p.toolId !== currentId) return;
        if (!p.done) {
          setWeightsDl({ percent: p.percent });
          return;
        }
        setWeightsDl(p.error ? { percent: 0, error: p.error } : null);
        void refreshTools().catch(() => {});
      }),
    [currentId]
  );
  useEffect(() => setWeightsDl(null), [currentId]);

  // "Added to Activity" after a run (the result lands in the gallery).
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
  useEffect(() => {
    if (!queuedNote) return;
    const id = window.setTimeout(() => setQueuedNote(null), 4000);
    return () => window.clearTimeout(id);
  }, [queuedNote]);
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [editModels, setEditModels] = useState<EditModelsInfo | null>(null);
  const [editModelsRev, setEditModelsRev] = useState(0);
  // Vary / inpaint / outpaint: the model a run would use (local and cloud).
  const [genModels, setGenModels] = useState<GenToolModels | null>(null);
  const [genRev, setGenRev] = useState(0);
  const maskRef = useRef<MaskEditorHandle>(null);
  const phase: Phase = formError ? "error" : "form";
  const error = formError;

  // Learn the real runtime once (starts the tools sidecar when installed).
  useEffect(() => {
    if (open) void refreshTools(true);
  }, [open]);

  // Default run-on = the global setting.
  useEffect(() => {
    if (!open) return;
    void api
      .getToolsSettings()
      .then((s) => setRunPref((s.mode as ToolsMode) || "auto"))
      .catch(() => {});
  }, [open]);

  // Reset when the dialog is (re)opened on another item/tool.
  useEffect(() => {
    if (!open) return;
    setCurrentId(toolId);
    setSrc(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, toolId, source.name]);

  // The source bytes (preview, mask editor, before/after).
  useEffect(() => {
    let alive = true;
    setSrcData(null);
    void src
      .getSrc()
      .then((d) => alive && setSrcData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [src]);

  // Fresh form per tool.
  const toolKey = tool?.id ?? "";
  useEffect(() => {
    if (!tool) return;
    setParams(defaultParams(tool));
    setRunPick(null);
    setFormError(null);
    setRefs([]);
    // Switching eraser <-> repaint keeps the painted mask (same editor).
    setHasMask(maskRef.current ? !maskRef.current.isEmpty() : false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolKey, src.name]);

  // Closing never cancels a run: it goes on in Activity. The small models are
  // freed only when no tool run is in flight.
  const close = useCallback(() => {
    if (!jobs.some((j) => j.kind === "tool" && j.status === "running")) void api.releaseTools().catch(() => {});
    onClose();
  }, [jobs, onClose]);

  const isMaskTool = (MASK_TOOLS as readonly string[]).includes(currentId);
  const isInstruct = currentId === INSTRUCT_EDIT_ID;
  const localOk = !!tool && (tool.badge === "local" || tool.badge === "local_slow");
  const runOn: "local" | "cloud" = runPick ?? (runPref === "auto" ? (localOk || !tool?.cloudAvailable ? "local" : "cloud") : runPref);
  const setRunOn = (v: ToolsMode) => setRunPick(v === "cloud" ? "cloud" : "local");
  const effectiveCloud = !!tool && runOn === "cloud";
  const sourceInput = src.name ?? srcData ?? "";

  // Edit with instructions: the edit models (cloud catalog + the loaded local
  // one), re-read when the badge changes (the local model was swapped).
  useEffect(() => {
    if (!open || !isInstruct) return;
    let alive = true;
    void api
      .listEditModels()
      .then((m) => alive && setEditModels(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, isInstruct, tool?.badge, editModelsRev]);
  const isGenTool = GEN_TOOL_IDS.has(currentId);
  useEffect(() => {
    if (!isGenTool) return;
    let alive = true;
    void api
      .toolGenModels(currentId, src.name, src.meta ?? null)
      .then((m) => alive && setGenModels(m))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isGenTool, currentId, src.name, src.meta, tool?.badge, genRev]);

  // Its cloud model defaults to the catalog's default edit model.
  useEffect(() => {
    if (!isInstruct || !editModels?.defaultCloud) return;
    setParams((p) => (p.model ? p : { ...p, model: editModels.defaultCloud }));
  }, [isInstruct, editModels?.defaultCloud, toolKey]);
  // The price follows the picked edit model (the list price is the default's).
  const pickedEditModel = isInstruct ? editModels?.cloud.find((m) => m.modelCode === params.model) : undefined;
  const priced: ToolInfo | undefined =
    tool && pickedEditModel && pickedEditModel.cost > 0
      ? { ...tool, priceCredits: pickedEditModel.cost, priceIsModel: false }
      : tool;
  const instructionMissing = isInstruct && !String(params.instruction ?? "").trim();
  // A local run whose model is not on disk yet: "Download model" first.
  const downloadMb = tool ? missingWeightsMb(tool, params) : 0;
  const needsDownload = !!tool && !effectiveCloud && !isWeb && downloadMb > 0;
  // The button says what it does ("Remove background"), not "Run".
  const actionLabel = tool ? t(`tools.action.${tool.id}`, { defaultValue: t("tools.run") }) : t("tools.run");

  const run = (forceRunOn?: ToolsMode) => {
    if (!tool || !sourceInput) return;
    const primary = tool.inputs.find((i) => i.type !== "mask");
    const inputs: Record<string, string[]> = {};
    if (primary) inputs[primary.name] = [sourceInput];
    if (tool.inputs.some((i) => i.type === "mask")) {
      const mask = maskRef.current?.exportMask();
      if (!mask) {
        setFormError({ code: "invalid_input", message: t("tools.mask.empty") });
        return;
      }
      inputs.mask = [mask];
    }
    if (isInstruct && refs.length) inputs.references = refs.map((r) => r.input);
    const jobId = newToolJobId();
    const instruction = isInstruct ? String(params.instruction ?? "").trim() : "";
    const label = toolName(t, tool) + (instruction ? ` · ${instruction}` : "");
    setFormError(null);
    onRunJob({ jobId, toolId: tool.id, inputs, params, runOn: forceRunOn ?? runOn }, label, src.name);
    setQueuedNote(label);
  };

  // The tools the header picker offers for this source (image or video).
  const srcIsVideo = src.kind === "video" || isVideo(srcData);
  const pickable = useMemo(
    () =>
      (srcIsVideo ? VIDEO_TOOL_IDS : ([...EDIT_TOOL_IDS, ...UTILITY_TOOL_IDS] as readonly string[]))
        .map((id) => toolById(tools, id))
        .filter((x): x is ToolInfo => !!x && x.id !== "video-concat"),
    [tools, srcIsVideo]
  );


  return (
    <div className="@container flex flex-col overflow-hidden rounded-xl border">
        <header className="flex items-center gap-3 border-b px-3 py-2.5">
          <span className="brand-surface flex size-8 items-center justify-center rounded-xl text-white">
            <ToolIcon id={currentId} className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              {tool ? toolName(t, tool) : currentId}
              {tool && <ToolBadgeChip badge={tool.badge} />}
            </h3>
            <p className="text-muted-foreground truncate text-xs">
              {tool ? t(`tools.desc.${tool.id}`, { defaultValue: tool.description }) : ""}
            </p>
          </div>
          {pickable.length > 1 && (
            <Select
              size="sm"
              value={currentId}
              onChange={(v) => v && setCurrentId(v)}
              aria-label={t("tools.pickTool")}
              className="max-w-[11rem]"
            >
              {pickable.map((x) => (
                <option key={x.id} value={x.id}>
                  {toolName(t, x)}
                </option>
              ))}
            </Select>
          )}
          <button
            type="button"
            onClick={close}
            aria-label={t("common.close")}
            title={t("common.close")}
            className="text-muted-foreground hover:text-foreground hover:bg-muted -mr-1 rounded-md p-1.5 transition-colors"
          >
            <X className="size-4" />
          </button>
        </header>

        {!tool ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 p-10 text-sm">
            <Loader2 className="size-4 animate-spin" /> {t("tools.loading")}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 gap-0 overflow-hidden @3xl:grid-cols-[1fr_300px]">
            {/* Left: the image / mask editor / result. */}
            <div className="bg-muted/30 relative flex min-h-[280px] items-center justify-center overflow-auto p-4">
              {!srcData ? (
                <Loader2 className="text-muted-foreground size-6 animate-spin" />
              ) : isMaskTool ? (
                <div className="w-full">
                  <MaskEditor
                    key={`${src.name ?? "inline"}`}
                    ref={maskRef}
                    src={srcData}
                    sourceInput={sourceInput}
                    initialMode={initialMaskMode ?? "brush"}
                    selectRunOn={runOn}
                    onChange={setHasMask}
                    onSelectError={(e) => {
                      // The offer would re-run the eraser, not the click: the
                      // run-on picker is the way to send selections to the cloud.
                      setFormError({ ...e, cloudRetry: undefined });
                    }}
                  />
                </div>
              ) : currentId === "crop" ? (
                <CropFrame
                  src={srcData}
                  params={params}
                  onChange={(r) => setParams((p) => ({ ...p, ...r, aspect: undefined }))}
                />
              ) : currentId === "outpaint" ? (
                <OutpaintFrame src={srcData} params={params} />
              ) : isVideo(srcData) ? (
                <video src={srcData} controls loop className="max-h-[60vh] max-w-full rounded-lg" />
              ) : (
                <img src={srcData} alt="" className="max-h-[60vh] max-w-full rounded-lg object-contain shadow" />
              )}
            </div>

            {/* Right: the form and where it runs. A run goes to Activity; its result to the gallery. */}
            <div className="flex min-h-0 flex-col border-t @3xl:border-t-0 @3xl:border-l">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                <>
                    {currentId === "outpaint" && (
                      <OutpaintSides params={params} onChange={(k, v) => setParams((p) => ({ ...p, [k]: v }))} />
                    )}
                    {isInstruct && (
                      <InstructEditForm
                        tool={tool}
                        params={params}
                        onChange={(k, v) =>
                          setParams((p) => {
                            const next = { ...p };
                            if (v === undefined) delete next[k];
                            else next[k] = v;
                            return next;
                          })
                        }
                        refs={refs}
                        onRefsChange={setRefs}
                        models={editModels}
                        cloud={effectiveCloud}
                        rail={rail}
                        onSubmit={() => {
                          if (!instructionMissing && srcData && tool.badge !== "unavailable") void run();
                        }}
                        onModelsChanged={isWeb ? undefined : () => setEditModelsRev((r) => r + 1)}
                      />
                    )}
                    <ParamsForm
                      tool={tool}
                      params={params}
                      sourcePrompt={src.meta?.prompt}
                      onChange={(k, v) =>
                        setParams((p) => {
                          const next = { ...p };
                          if (v === undefined) delete next[k];
                          else next[k] = v;
                          return next;
                        })
                      }
                    />
                    {isGenTool && !isWeb && (
                      <GenModelBox
                        models={genModels}
                        cloud={effectiveCloud}
                        onChanged={() => setGenRev((r) => r + 1)}
                      />
                    )}
                    {isGenTool && isWeb && genModels?.cloud && (
                      <GenModelBox models={genModels} cloud onChanged={() => {}} />
                    )}
                    <RunOnPicker tool={priced ?? tool} value={runOn} onChange={setRunOn} rail={rail} />
                    <WhereNotice tool={priced ?? tool} cloud={effectiveCloud} rail={rail} params={params} />
                </>

                {phase === "error" && error && (
                  <ErrorPanel
                    error={error}
                    previous={isGenTool ? genModels?.previous : undefined}
                    onSwitched={() => setGenRev((r) => r + 1)}
                    rail={rail}
                    onCloud={() => {
                      setRunOn("cloud");
                      void run("cloud");
                    }}
                  />
                )}
              </div>

              <footer className="flex items-center gap-2 border-t p-3">
                <div className="flex-1 space-y-1.5">
                  {needsDownload ? (
                    weightsDl && !weightsDl.error ? (
                      <div className="space-y-1.5">
                        <ProgressBar percent={weightsDl.percent || null} />
                        <div className="flex items-center gap-2">
                          <p className="text-muted-foreground flex-1 text-[11px]">
                            {t("tools.downloading", { percent: weightsDl.percent, mb: Math.round(downloadMb) })}
                          </p>
                          <Button size="sm" variant="ghost" onClick={() => void api.cancelToolWeights()}>
                            {t("common.cancel")}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <Button
                          className="w-full"
                          onClick={() => {
                            setWeightsDl({ percent: 0 });
                            void api.downloadToolWeights(tool.id, params).catch((e: unknown) =>
                              setWeightsDl({ percent: 0, error: e instanceof Error ? e.message : String(e) })
                            );
                          }}
                        >
                          <Download className="size-3.5" />
                          {t("tools.downloadModel", { mb: Math.max(1, Math.round(downloadMb)) })}
                        </Button>
                        {weightsDl?.error && (
                          <p className="text-destructive text-[11px] break-words">{weightsDl.error}</p>
                        )}
                      </>
                    )
                  ) : (
                    <Button
                      className="w-full"
                      disabled={!srcData || tool.badge === "unavailable" || (isMaskTool && !hasMask) || instructionMissing}
                      onClick={() => void run()}
                    >
                      <Play className="size-3.5" />
                      {effectiveCloud
                        ? t("tools.actionCloud", {
                            action: actionLabel,
                            price: formatToolPrice(t, (priced ?? tool).priceCredits, rail, (priced ?? tool).priceIsModel),
                          })
                        : actionLabel}
                    </Button>
                  )}
                  {queuedNote && (
                    <p className="flex items-center justify-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3.5" /> {t("tools.queued")}
                    </p>
                  )}
                </div>
              </footer>
            </div>
          </div>
        )}
    </div>
  );
}

// ------------------------------------------------------------------------

function ParamsForm({
  tool,
  params,
  sourcePrompt,
  onChange,
  disabled,
}: {
  tool: ToolInfo;
  params: Record<string, unknown>;
  sourcePrompt?: string;
  onChange: (name: string, value: unknown) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const hidden = HIDDEN_PARAMS[tool.id] ?? new Set<string>();
  const shown = tool.params.filter((p) => !hidden.has(p.name) && p.type !== "points");
  if (shown.length === 0) return null;
  return (
    <div className="space-y-3">
      {shown.map((p) => (
        <ParamField
          key={p.name}
          toolId={tool.id}
          spec={p}
          value={params[p.name]}
          placeholder={p.name === "prompt" && sourcePrompt ? sourcePrompt : undefined}
          onChange={(v) => onChange(p.name, v)}
          disabled={disabled}
          label={t(`tools.params.${p.name}`, { defaultValue: humanize(p.name) })}
          hint={t(`tools.paramHints.${tool.id}.${p.name}`, { defaultValue: p.description ?? "" })}
        />
      ))}
    </div>
  );
}

function humanize(name: string): string {
  const s = name.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ParamField({
  toolId,
  spec,
  value,
  onChange,
  label,
  hint,
  placeholder,
  disabled,
}: {
  toolId: string;
  spec: ToolParamSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  label: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const valueLabel = (v: string | number) => t(`tools.values.${String(v)}`, { defaultValue: String(v) });
  const id = `tp-${toolId}-${spec.name}`;
  let control: React.ReactNode;
  switch (spec.type) {
    case "enum": {
      const vals = spec.values ?? [];
      control =
        vals.length <= 4 ? (
          <Segmented<string>
            size="sm"
            wrap
            className="w-full"
            value={value === undefined ? "" : String(value)}
            onChange={(v) => onChange(coerceParam(spec, v))}
            items={vals.map((v) => ({ value: String(v), label: valueLabel(v) }))}
          />
        ) : (
          <Select
            id={id}
            size="sm"
            fullWidth
            value={value === undefined ? "" : String(value)}
            onChange={(v) => onChange(coerceParam(spec, v))}
            disabled={disabled}
          >
            {vals.map((v) => (
              <option key={String(v)} value={String(v)}>
                {valueLabel(v)}
              </option>
            ))}
          </Select>
        );
      break;
    }
    case "bool":
      control = (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox id={id} checked={!!value} onCheckedChange={(c) => onChange(c)} disabled={disabled} />
          {label}
        </label>
      );
      return (
        <div className="grid gap-1">
          {control}
          {hint && <p className="text-muted-foreground text-[11px] leading-snug">{hint}</p>}
        </div>
      );
    case "int":
    case "float": {
      const bounded = spec.min !== undefined && spec.max !== undefined && spec.max - spec.min <= 100000;
      const step = spec.type === "int" ? 1 : (spec.max ?? 1) - (spec.min ?? 0) <= 2 ? 0.05 : 0.1;
      const num = value === undefined || value === null ? "" : String(value);
      control = (
        <div className="flex items-center gap-2">
          {bounded && (
            <input
              type="range"
              min={spec.min}
              max={spec.max}
              step={step}
              value={num === "" ? Number(spec.default ?? spec.min) : Number(num)}
              onChange={(e) => onChange(coerceParam(spec, e.target.value))}
              disabled={disabled}
              className="min-w-0 flex-1 accent-[var(--brand-to)]"
            />
          )}
          <Input
            id={id}
            type="number"
            min={spec.min}
            max={spec.max}
            step={step}
            value={num}
            placeholder={t("tools.auto")}
            onChange={(e) => onChange(coerceParam(spec, e.target.value))}
            disabled={disabled}
            className={cn("h-8 text-xs", bounded ? "w-20" : "w-full")}
          />
        </div>
      );
      break;
    }
    default: {
      const long = spec.name === "prompt" || spec.name === "negative_prompt";
      control = long ? (
        <Textarea
          id={id}
          rows={3}
          value={(value as string) ?? ""}
          placeholder={placeholder ?? (spec.name === "prompt" ? t("tools.promptPlaceholder") : undefined)}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="text-xs"
        />
      ) : (
        <Input
          id={id}
          value={(value as string) ?? ""}
          placeholder={placeholder ?? t("tools.auto")}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
          disabled={disabled}
          className="h-8 text-xs"
        />
      );
    }
  }
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {control}
      {hint && <p className="text-muted-foreground text-[11px] leading-snug">{hint}</p>}
    </div>
  );
}

function RunOnPicker({
  tool,
  value,
  onChange,
  rail,
}: {
  tool: ToolInfo;
  value: ToolsMode;
  onChange: (v: ToolsMode) => void;
  rail: string;
}) {
  const { t } = useTranslation();
  const localOk = tool.badge === "local" || tool.badge === "local_slow";
  return (
    <div className="grid gap-1.5 border-t pt-3">
      <span className="text-xs font-medium">{t("tools.runOn")}</span>
      <Segmented<ToolsMode>
        size="sm"
        className="w-full"
        value={value}
        onChange={onChange}
        items={[
          { value: "local", label: t("tools.mode.local"), icon: <Cpu className="size-3" /> },
          { value: "cloud", label: t("tools.mode.cloud"), icon: <Cloud className="size-3" /> },
        ]}
      />
      {value === "local" && !localOk && (
        <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
          {t(`tools.reason.${tool.reason ?? "no_device"}`, { defaultValue: t("tools.reason.no_device") })}
        </p>
      )}
      {value === "cloud" && !tool.cloudAvailable && (
        <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">{t("tools.noCloud")}</p>
      )}
      {value !== "local" && tool.cloudAvailable && (
        <p className="text-muted-foreground text-[11px]">
          {t("tools.cloudPrice", { price: formatToolPrice(t, tool.priceCredits, rail, tool.priceIsModel) })}
        </p>
      )}
    </div>
  );
}

/** MB a local run still has to download: the weights of the chosen variant
 *  (their "when" matches the params) that are not cached yet. */
function missingWeightsMb(tool: ToolInfo, params: Record<string, unknown>): number {
  if (!tool.weights) return tool.weightsMb;
  return tool.weights
    .filter((w) => !w.cached)
    .filter((w) => Object.entries(w.when ?? {}).every(([k, v]) => String(params[k] ?? "") === String(v)))
    .reduce((n, w) => n + w.sizeMb, 0);
}

function WhereNotice({
  tool,
  cloud,
  rail,
  params,
}: {
  tool: ToolInfo;
  cloud: boolean;
  rail: string;
  params: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const downloadMb = missingWeightsMb(tool, params);
  if (cloud) {
    return (
      <div className="flex gap-2 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-xs leading-relaxed text-sky-800 dark:text-sky-200">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-medium">{t("tools.privacyTitle")}</p>
          <p>{t("tools.privacyBody")}</p>
          <p className="mt-1 font-medium">
            {t("tools.priceLine", { price: formatToolPrice(t, tool.priceCredits, rail, tool.priceIsModel) })}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="bg-muted/50 flex gap-2 rounded-xl p-3 text-xs leading-relaxed">
      <Cpu className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div>
        <p className="font-medium">{t("tools.localTitle", { device: (tool.device ?? "").toUpperCase() })}</p>
        <p className="text-muted-foreground">
          {tool.badge === "local_slow" ? t("tools.localSlowBody") : t("tools.localBody")}
        </p>
        {downloadMb > 0 && (
          <p className="text-muted-foreground">{t("tools.weightsNote", { mb: Math.max(1, Math.round(downloadMb)) })}</p>
        )}
      </div>
    </div>
  );
}

function ErrorPanel({
  error,
  rail,
  onCloud,
  previous,
  onSwitched,
}: {
  error: ToolError;
  rail: string;
  onCloud: () => void;
  /** The model to switch back to when an edit model blocks the run. */
  previous?: ModelInfo | null;
  onSwitched?: () => void;
}) {
  const { t } = useTranslation();
  const sw = useModelSwitch(onSwitched ?? (() => {}));
  // A known reason reads as a sentence, not as a code in parentheses.
  const why = error.reason ? t(`tools.reason.${error.reason}`, { defaultValue: "" }) : "";
  return (
    <div className="border-destructive/25 bg-destructive/5 space-y-2 rounded-xl border p-3 text-xs">
      <div className="text-destructive flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-medium">{t(`tools.errors.${error.code}`, { defaultValue: t("tools.errors.internal") })}</p>
          <p className="text-destructive/80 mt-0.5 break-words">{why || error.message}</p>
        </div>
      </div>
      {error.reason === "edit_model_loaded" && previous && (
        <SwitchBackButton sw={sw} previous={previous} />
      )}
      {error.cloudRetry && (
        <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-2.5 text-sky-800 dark:text-sky-200">
          <p>{t("tools.cloudRetryBody")}</p>
          <p className="font-medium">
            {t("tools.priceLine", { price: formatToolPrice(t, error.cloudRetry.credits, rail) })}
          </p>
          <Button size="sm" className="w-full" onClick={onCloud}>
            <Cloud className="size-3.5" /> {t("tools.cloudRetryAction")} <ArrowRight className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------
// Edit with instructions: the instruction on top, optional reference images,
// the model, keep size, and an advanced section.
// ------------------------------------------------------------------------

const REF_MAX_MB = 30;

function InstructEditForm({
  tool,
  params,
  onChange,
  refs,
  onRefsChange,
  models,
  cloud,
  rail,
  disabled,
  onSubmit,
  onModelsChanged,
}: {
  tool: ToolInfo;
  params: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  refs: RefImage[];
  onRefsChange: (r: RefImage[]) => void;
  models: EditModelsInfo | null;
  cloud: boolean;
  rail: string;
  disabled?: boolean;
  onSubmit: () => void;
  /** Desktop only: re-read the edit models after a local model switch. */
  onModelsChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  const [picking, setPicking] = useState(false);
  const [refError, setRefError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refSpec = tool.inputs.find((i) => i.name === "references");
  const maxRefs = refSpec?.maxItems ?? 2;
  const spec = (name: string) => tool.params.find((p) => p.name === name);
  const instructionSpec = spec("instruction");
  const addRef = (r: RefImage) => {
    setRefError(null);
    if (refs.length >= maxRefs) return;
    onRefsChange([...refs, r]);
  };
  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > REF_MAX_MB * 1024 * 1024) {
      setRefError(t("tools.instruct.refTooLarge", { mb: REF_MAX_MB }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (url.startsWith("data:image/")) addRef({ input: url, preview: url, label: f.name });
      else setRefError(t("tools.instruct.refNotImage"));
    };
    reader.readAsDataURL(f);
  };
  const advancedFields = ["negative_prompt", "steps", "guidance", "seed"]
    .map(spec)
    .filter((p): p is ToolParamSpec => !!p);
  const cloudModels = models?.cloud ?? [];
  const modelValue = String(params.model ?? models?.defaultCloud ?? "");

  return (
    <div className="space-y-3">
      {/* The instruction is the hero of this dialog. */}
      <div className="grid gap-1.5">
        <label htmlFor="ie-instruction" className="text-xs font-medium">
          {t("tools.params.instruction")}
        </label>
        <Textarea
          id="ie-instruction"
          rows={4}
          autoFocus
          maxLength={instructionSpec?.maxLength}
          value={(params.instruction as string) ?? ""}
          placeholder={t("tools.instruct.placeholder")}
          onChange={(e) => onChange("instruction", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit();
            }
          }}
          disabled={disabled}
          className="min-h-24 text-sm"
        />
        <p className="text-muted-foreground text-[11px] leading-snug">{t("tools.instruct.hint")}</p>
      </div>

      {/* Optional reference images ("image 2", "image 3" in the instruction). */}
      <div className="grid gap-1.5">
        <span className="text-xs font-medium">
          {t("tools.instruct.references", { max: maxRefs })}
        </span>
        {refs.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {refs.map((r, i) => (
              <div key={i} className="group relative">
                <img
                  src={r.preview}
                  alt={r.label}
                  title={r.label}
                  className="size-16 rounded-lg border object-cover"
                />
                <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] text-white">
                  {t("tools.instruct.imageN", { n: i + 2 })}
                </span>
                <button
                  type="button"
                  aria-label={t("tools.instruct.removeRef")}
                  onClick={() => onRefsChange(refs.filter((_, j) => j !== i))}
                  disabled={disabled}
                  className="bg-background absolute -top-1.5 -right-1.5 rounded-full border p-0.5 shadow"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {refs.length < maxRefs && (
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" className="flex-1" disabled={disabled} onClick={() => setPicking((p) => !p)}>
              <Images className="size-3.5" /> {t("tools.instruct.fromGallery")}
            </Button>
            <Button variant="outline" size="sm" className="flex-1" disabled={disabled} onClick={() => fileRef.current?.click()}>
              <ImagePlus className="size-3.5" /> {t("tools.instruct.fromFile")}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        )}
        {picking && refs.length < maxRefs && (
          <GalleryPicker
            onPick={(name, preview) => {
              addRef({ input: name, preview, label: name });
              setPicking(false);
            }}
          />
        )}
        {refError && <p className="text-destructive text-[11px]">{refError}</p>}
      </div>

      {/* Model: the loaded local edit model, or a cloud edit model. */}
      <div className="grid gap-1.5">
        <span className="text-xs font-medium">{t("tools.params.model")}</span>
        {cloud ? (
          cloudModels.length > 0 ? (
            <Select
              size="sm"
              fullWidth
              value={modelValue}
              onChange={(v) => onChange("model", v)}
              disabled={disabled}
              aria-label={t("tools.params.model")}
            >
              {!cloudModels.some((m) => m.modelCode === modelValue) && modelValue && (
                <option value={modelValue}>{modelValue}</option>
              )}
              {cloudModels.map((m) => (
                <option key={m.modelCode} value={m.modelCode}>
                  {m.name || m.modelCode}
                  {m.cost > 0 ? ` · ${formatToolPrice(t, m.cost, rail)}` : ""}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-muted-foreground text-xs">{modelValue || "qwen-image-edit-2511"}</p>
          )
        ) : (
          <p className="text-xs">
            {models?.local?.name ?? models?.local?.modelCode ?? t("tools.instruct.localModel")}
            <span className="text-muted-foreground"> · {t("tools.instruct.onThisComputer")}</span>
          </p>
        )}
        {tool.badge === "cloud" && !onModelsChanged && (
          <p className="text-muted-foreground text-[11px] leading-snug">{t("tools.instruct.localHint")}</p>
        )}
        {onModelsChanged && <EditModelSwitch models={models} disabled={disabled} onChanged={onModelsChanged} />}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={params.keep_size !== false}
          onCheckedChange={(c) => onChange("keep_size", !!c)}
          disabled={disabled}
        />
        {t("tools.params.keep_size")}
      </label>

      <div className="border-t pt-2">
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 text-xs font-medium"
          aria-expanded={advanced}
        >
          <ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} />
          {t("tools.instruct.advanced")}
        </button>
        {advanced && (
          <div className="mt-3 space-y-3">
            {advancedFields.map((p) => (
              <ParamField
                key={p.name}
                toolId={tool.id}
                spec={p}
                value={params[p.name]}
                onChange={(v) => onChange(p.name, v)}
                disabled={disabled}
                label={t(`tools.params.${p.name}`, { defaultValue: humanize(p.name) })}
                hint={t(`tools.paramHints.${tool.id}.${p.name}`, { defaultValue: p.description ?? "" })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const PICKER_PAGE = 9;

/** A small grid of recent gallery images to pick a reference from. */
function GalleryPicker({ onPick }: { onPick: (name: string, preview: string) => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<SavedImage[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadMore = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const page = await api.listSavedImages(offset, PICKER_PAGE, { engine: "", modelCode: "", source: "", text: "" });
        const imgs = (page ?? []).filter((x) => x.kind !== "video");
        setItems((prev) => [...prev, ...imgs]);
        if ((page ?? []).length < PICKER_PAGE) setDone(true);
        for (const x of imgs) {
          void api
            .getSavedImage(x.name)
            .then((d) => setThumbs((m) => ({ ...m, [x.name]: d })))
            .catch(() => {});
        }
      } catch {
        setDone(true);
      } finally {
        setLoading(false);
      }
    },
    []
  );
  const offsetRef = useRef(0);
  useEffect(() => {
    void loadMore(0);
    offsetRef.current = PICKER_PAGE;
  }, [loadMore]);

  return (
    <div className="space-y-2 rounded-xl border p-2">
      {items.length === 0 && !loading ? (
        <p className="text-muted-foreground p-2 text-xs">{t("tools.instruct.galleryEmpty")}</p>
      ) : (
        <div className="grid grid-cols-3 gap-1.5">
          {items.map((x) => (
            <button
              key={x.name}
              type="button"
              disabled={!thumbs[x.name]}
              onClick={() => thumbs[x.name] && onPick(x.name, thumbs[x.name])}
              title={x.meta?.prompt || x.name}
              className="bg-muted aspect-square overflow-hidden rounded-md border hover:ring-2 hover:ring-[var(--brand-to)]"
            >
              {thumbs[x.name] ? (
                <img src={thumbs[x.name]} alt="" className="size-full object-cover" />
              ) : (
                <Loader2 className="text-muted-foreground mx-auto size-4 animate-spin" />
              )}
            </button>
          ))}
        </div>
      )}
      {!done && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          disabled={loading}
          onClick={() => {
            void loadMore(offsetRef.current);
            offsetRef.current += PICKER_PAGE;
          }}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : t("tools.instruct.more")}
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------
// Outpaint: four sides + a preview of the expanded frame.
// ------------------------------------------------------------------------

const SIDES = ["left", "right", "top", "bottom"] as const;

function OutpaintSides({
  params,
  onChange,
}: {
  params: Record<string, unknown>;
  onChange: (side: string, v: number) => void;
}) {
  const { t } = useTranslation();
  const all = (n: number) => SIDES.forEach((s) => onChange(s, n));
  return (
    <div className="space-y-2">
      <span className="text-xs font-medium">{t("tools.outpaint.title")}</span>
      <div className="grid grid-cols-2 gap-2">
        {SIDES.map((s) => (
          <label key={s} className="grid gap-1 text-[11px]">
            <span className="text-muted-foreground">{t(`tools.outpaint.${s}`)}</span>
            <Input
              type="number"
              min={0}
              max={2048}
              step={64}
              value={Number(params[s] ?? 0)}
              onChange={(e) => onChange(s, Math.max(0, Math.min(2048, Math.round(Number(e.target.value) || 0))))}
              className="h-8 text-xs"
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {[128, 256, 512].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => all(n)}
            className="hover:bg-muted rounded-md border px-2 py-0.5 text-[11px]"
          >
            {t("tools.outpaint.allSides", { px: n })}
          </button>
        ))}
        <button type="button" onClick={() => all(0)} className="hover:bg-muted rounded-md border px-2 py-0.5 text-[11px]">
          {t("common.clear")}
        </button>
      </div>
    </div>
  );
}

function OutpaintFrame({ src, params }: { src: string; params: Record<string, unknown> }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const l = Number(params.left ?? 0);
  const r = Number(params.right ?? 0);
  const tp = Number(params.top ?? 0);
  const b = Number(params.bottom ?? 0);
  if (!dims) {
    return (
      <img
        src={src}
        alt=""
        onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        className="max-h-[60vh] max-w-full rounded-lg"
      />
    );
  }
  const W = dims.w + l + r;
  const H = dims.h + tp + b;
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <div
        className="checkerboard relative w-full rounded-lg border-2 border-dashed border-[var(--brand-to)]/70"
        style={{ aspectRatio: `${W} / ${H}`, maxWidth: `min(100%, calc(56vh * ${W / H}))` }}
      >
        <img
          src={src}
          alt=""
          className="absolute shadow-lg"
          style={{
            left: `${(l / W) * 100}%`,
            top: `${(tp / H) * 100}%`,
            width: `${(dims.w / W) * 100}%`,
            height: `${(dims.h / H) * 100}%`,
          }}
        />
      </div>
      <span className="text-muted-foreground text-[11px] tabular-nums">
        {dims.w}×{dims.h} → {W}×{H}
      </span>
    </div>
  );
}

/** "Edit on this computer": swap the local model to the edit model (download
 *  the first time, progress from "model:progress") and back. Desktop only. */
function EditModelSwitch({
  models,
  disabled,
  onChanged,
}: {
  models: EditModelsInfo | null;
  disabled?: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    return api.onModelProgress((p) => {
      setProgress(p);
      if (p.done || p.phase === "done" || p.phase === "error" || p.phase === "cancelled") {
        setBusy(false);
        if (p.phase === "error") setError(p.error ?? "error");
        onChanged();
      }
    });
  }, [busy, onChanged]);

  const start = (fn: () => Promise<void>) => {
    setError(null);
    setProgress(null);
    setBusy(true);
    fn().catch((e) => {
      setBusy(false);
      setError(String((e as Error)?.message ?? e));
    });
  };

  const candidate = models?.localCandidate;
  const local = models?.local;
  if (!models || (!local && !candidate)) return null;

  return (
    <div className="bg-muted/40 mt-1 space-y-2 rounded-lg border p-2.5">
      {local ? (
        models.previous && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={disabled || busy}
            onClick={() => start(api.switchBackFromEditModel)}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Cpu className="size-3.5" />}
            {t("tools.instruct.switchBack", { name: models.previous.name || models.previous.modelCode })}
          </Button>
        )
      ) : (
        candidate && (
          <>
            <p className="text-xs font-medium">{t("tools.instruct.switchTitle")}</p>
            <p className="text-muted-foreground text-[11px] leading-snug">
              {t("tools.instruct.switchText", { name: candidate.name || candidate.modelCode })}
              {!models.localCandidateCached && <> {t("tools.instruct.switchDownload")}</>}
            </p>
            <Button size="sm" className="w-full" disabled={disabled || busy} onClick={() => start(api.switchToEditModel)}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Cpu className="size-3.5" />}
              {busy ? t("tools.instruct.switching") : t("tools.instruct.switchButton")}
            </Button>
          </>
        )
      )}
      {busy && progress && (
        <div className="space-y-1">
          <ProgressBar percent={progress.percentEstimate || null} />
          <p className="text-muted-foreground truncate text-[11px]">
            {progress.messageKey ? t(progress.messageKey, progress.messageArgs ?? {}) : progress.message}
          </p>
        </div>
      )}
      {error && <p className="text-destructive text-[11px]">{t("tools.instruct.switchFailed", { error })}</p>}
    </div>
  );
}

/** The tool a fresh source opens on in the Edit panel. */
export function defaultToolFor(kind?: string): string {
  return kind === "video" ? "video-trim" : INSTRUCT_EDIT_ID;
}

/** The Edit panel with nothing open: drop a gallery tile or a file, or pick
 *  one. The panel is a drop target (.edit-drop-surface) for gallery drags. */
export function EditEmpty({
  dropActive,
  galleryHidden,
  onShowGallery,
  onOpen,
}: {
  dropActive: boolean;
  galleryHidden: boolean;
  onShowGallery: () => void;
  onOpen: (src: ToolSource) => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const openFile = (f: File | undefined) => {
    if (!f || !(f.type.startsWith("image/") || f.type.startsWith("video/"))) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (!url.startsWith("data:")) return;
      onOpen({ name: null, kind: f.type.startsWith("video/") ? "video" : "image", getSrc: async () => url });
    };
    reader.readAsDataURL(f);
  };
  return (
    <div
      className={cn(
        "edit-drop-surface border-border/70 flex min-h-[280px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-6 text-center transition-colors",
        (dropActive || over) && "border-primary bg-primary/5"
      )}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        openFile(e.dataTransfer.files?.[0]);
      }}
    >
      <span className="brand-surface flex size-11 items-center justify-center rounded-2xl text-white">
        <ImagePlus className="size-5" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("tools.empty.title")}</p>
        <p className="text-muted-foreground max-w-xs text-xs leading-relaxed">{t("tools.empty.hint")}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <FolderOpen className="size-3.5" /> {t("tools.empty.openFile")}
        </Button>
        {galleryHidden && (
          <Button size="sm" variant="outline" onClick={onShowGallery}>
            <Images className="size-3.5" /> {t("tools.empty.showGallery")}
          </Button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
        className="hidden"
        onChange={(e) => {
          openFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

const GEN_TOOL_IDS = new Set(["vary", "inpaint", "outpaint"]);

/** Swap the local model (download/load progress from "model:progress"). */
function useModelSwitch(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (!busy) return;
    return api.onModelProgress((p) => {
      setProgress(p);
      if (p.done || p.phase === "done" || p.phase === "error" || p.phase === "cancelled") {
        setBusy(false);
        if (p.phase === "error") setError(p.error ?? "error");
        doneRef.current();
      }
    });
  }, [busy]);
  const start = (fn: () => Promise<void>) => {
    setError(null);
    setProgress(null);
    setBusy(true);
    fn().catch((e) => {
      setBusy(false);
      setError(String((e as Error)?.message ?? e));
    });
  };
  return { busy, progress, error, start };
}

function SwitchProgress({ sw }: { sw: ReturnType<typeof useModelSwitch> }) {
  const { t } = useTranslation();
  return (
    <>
      {sw.busy && sw.progress && (
        <div className="space-y-1">
          <ProgressBar percent={sw.progress.percentEstimate || null} />
          <p className="text-muted-foreground truncate text-[11px]">
            {sw.progress.messageKey ? t(sw.progress.messageKey, sw.progress.messageArgs ?? {}) : sw.progress.message}
          </p>
        </div>
      )}
      {sw.error && <p className="text-destructive text-[11px]">{t("tools.instruct.switchFailed", { error: sw.error })}</p>}
    </>
  );
}

function SwitchBackButton({ sw, previous }: { sw: ReturnType<typeof useModelSwitch>; previous: ModelInfo }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Button size="sm" variant="outline" className="w-full" disabled={sw.busy} onClick={() => sw.start(api.switchBackFromEditModel)}>
        {sw.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Cpu className="size-3.5" />}
        {t("tools.instruct.switchBack", { name: previous.name || previous.modelCode })}
      </Button>
      <SwitchProgress sw={sw} />
    </div>
  );
}

/** Vary / inpaint / outpaint: which model the run uses, why, and the fixes
 *  (load the image's own model, switch back from an edit model). */
function GenModelBox({
  models,
  cloud,
  disabled,
  onChanged,
}: {
  models: GenToolModels | null;
  cloud: boolean;
  disabled?: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const sw = useModelSwitch(onChanged);
  if (!models) return null;
  const source = models.sourceModelName || models.sourceModel;
  const local = models.local;
  const editLoaded = !!local && local.backendType === "qwenimage-edit";
  const name = (m?: ModelInfo | null) => (m ? m.name || m.modelCode : "");

  return (
    <div className="space-y-2 rounded-xl border p-3 text-xs">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{t("tools.gen.model")}</p>
      {cloud ? (
        models.cloud ? (
          <>
            <p className="flex items-center gap-1.5 font-medium">
              <Cloud className="size-3.5 shrink-0" /> {name(models.cloud)}
            </p>
            <p className="text-muted-foreground leading-snug">
              {source && models.cloud.modelCode === models.sourceModel
                ? t("tools.gen.sameModel")
                : source
                  ? t("tools.gen.otherModelCloud", { source })
                  : t("tools.gen.selectedCloud")}
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">{t("tools.gen.noCloudModel")}</p>
        )
      ) : editLoaded ? (
        <>
          <p className="leading-snug text-amber-700 dark:text-amber-300">{t("tools.gen.editLoaded", { name: name(local) })}</p>
          {models.previous && <SwitchBackButton sw={sw} previous={models.previous} />}
        </>
      ) : local ? (
        <>
          <p className="flex items-center gap-1.5 font-medium">
            <Cpu className="size-3.5 shrink-0" /> {name(local)}
          </p>
          <p className="text-muted-foreground leading-snug">
            {models.localIsSource
              ? t("tools.gen.sameModel")
              : source
                ? t("tools.gen.otherModelLocal", { source })
                : t("tools.gen.loadedModel")}
          </p>
          {!models.localIsSource && models.sourceLocal && (
            <div className="space-y-1.5">
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={disabled || sw.busy}
                onClick={() => sw.start(() => api.selectLocalModel(models.sourceLocal!.modelCode))}
              >
                {sw.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Cpu className="size-3.5" />}
                {t("tools.gen.loadSource", { name: name(models.sourceLocal) })}
              </Button>
              <SwitchProgress sw={sw} />
            </div>
          )}
        </>
      ) : (
        <p className="text-muted-foreground">{t("tools.gen.noLocalModel")}</p>
      )}
    </div>
  );
}
