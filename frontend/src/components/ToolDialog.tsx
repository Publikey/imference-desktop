// ToolDialog — runs one editing tool on a gallery item.
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
  Cloud,
  Copy,
  Cpu,
  FolderOpen,
  ImageIcon,
  Loader2,
  Maximize2,
  Play,
  ShieldAlert,
  Square,
  SplitSquareHorizontal,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/segmented";
import { ProgressBar } from "@/components/ui/progress";
import { MaskEditor, type MaskEditorHandle, type MaskMode } from "@/components/MaskEditor";
import { ToolBadgeChip, ToolIcon, formatToolPrice, toolName, usePaymentRail } from "@/components/ToolBits";
import { api } from "@/lib/wails-bridge";
import {
  EDIT_TOOL_IDS,
  HIDDEN_PARAMS,
  KNOWN_STAGES,
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
import type {
  GenerationMeta,
  ToolError,
  ToolInfo,
  ToolParamSpec,
  ToolProgress,
  ToolRunResult,
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

const MASK_TOOLS = ["erase-object", "inpaint"] as const;

function isVideo(src: string | null | undefined): boolean {
  return !!src && src.startsWith("data:video/");
}

export function ToolDialog({
  open,
  toolId,
  source,
  initialMaskMode,
  onClose,
  onSaved,
  onOpenSaved,
  onUseAsSource,
}: {
  open: boolean;
  toolId: string;
  source: ToolSource;
  /** "select" when opened from "Click to select". */
  initialMaskMode?: MaskMode;
  onClose: () => void;
  /** Outputs were saved to the gallery (refresh it). */
  onSaved: (names: string[]) => void;
  /** Open a saved output in the gallery viewer. */
  onOpenSaved: (name: string) => void;
  onUseAsSource: (getSrc: () => Promise<string>) => void;
}) {
  const { t } = useTranslation();
  const tools = useTools();
  const rail = usePaymentRail();
  const [currentId, setCurrentId] = useState(toolId);
  const [src, setSrc] = useState<ToolSource>(source);
  const tool = toolById(tools, currentId);

  const [srcData, setSrcData] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [runOn, setRunOn] = useState<ToolsMode>("auto");
  const [phase, setPhase] = useState<Phase>("form");
  const [progress, setProgress] = useState<ToolProgress | null>(null);
  const [result, setResult] = useState<ToolRunResult | null>(null);
  const [error, setError] = useState<ToolError | null>(null);
  const [resultSrc, setResultSrc] = useState<string | null>(null);
  const [showBefore, setShowBefore] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const [copied, setCopied] = useState(false);
  const jobRef = useRef<string>("");
  const maskRef = useRef<MaskEditorHandle>(null);

  // Learn the real runtime once (starts the tools sidecar when installed).
  useEffect(() => {
    if (open) void refreshTools(true);
  }, [open]);

  // Default run-on = the global setting.
  useEffect(() => {
    if (!open) return;
    void api
      .getToolsSettings()
      .then((s) => setRunOn((s.mode as ToolsMode) || "auto"))
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
    setPhase("form");
    setResult(null);
    setError(null);
    setResultSrc(null);
    setProgress(null);
    setShowBefore(false);
    // Switching eraser <-> repaint keeps the painted mask (same editor).
    setHasMask(maskRef.current ? !maskRef.current.isEmpty() : false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolKey, src.name]);

  // Stage progress for the running job.
  useEffect(() => {
    if (!open) return;
    return api.onToolProgress((p) => {
      if (p.jobId === jobRef.current) setProgress(p);
    });
  }, [open]);

  const close = useCallback(() => {
    if (phase === "running" && jobRef.current) void api.cancelTool(jobRef.current);
    // Free the small models loaded during this editing session.
    void api.releaseTools().catch(() => {});
    onClose();
  }, [phase, onClose]);

  const isMaskTool = (MASK_TOOLS as readonly string[]).includes(currentId);
  const effectiveCloud = !!tool && (runOn === "cloud" || (runOn === "auto" && tool.badge === "cloud"));
  const sourceInput = src.name ?? srcData ?? "";

  const run = async (forceRunOn?: ToolsMode) => {
    if (!tool || !sourceInput) return;
    const primary = tool.inputs.find((i) => i.type !== "mask");
    const inputs: Record<string, string[]> = {};
    if (primary) inputs[primary.name] = [sourceInput];
    if (tool.inputs.some((i) => i.type === "mask")) {
      const mask = maskRef.current?.exportMask();
      if (!mask) {
        setError({ code: "invalid_input", message: t("tools.mask.empty") });
        setPhase("error");
        return;
      }
      inputs.mask = [mask];
    }
    const jobId = newToolJobId();
    jobRef.current = jobId;
    setPhase("running");
    setError(null);
    setResult(null);
    setResultSrc(null);
    setProgress(null);
    const res = await api
      .runTool({ jobId, toolId: tool.id, inputs, params, runOn: forceRunOn ?? runOn })
      .catch(
        (e: unknown): ToolRunResult => ({
          jobId,
          toolId: tool.id,
          outputs: [],
          durationMs: 0,
          error: { code: "internal", message: e instanceof Error ? e.message : String(e) },
        })
      );
    if (jobRef.current !== jobId) return; // superseded
    if (res.error) {
      setError(res.error);
      setPhase(res.error.code === "cancelled" ? "form" : "error");
      return;
    }
    setResult(res);
    setPhase("done");
    const saved = res.outputs.map((o) => o.savedName).filter((n): n is string => !!n);
    if (saved.length) {
      onSaved(saved);
      void api
        .getSavedImage(saved[0])
        .then(setResultSrc)
        .catch(() => {});
    }
  };

  const cancel = () => {
    if (jobRef.current) void api.cancelTool(jobRef.current);
  };

  const firstSaved = result?.outputs.find((o) => o.savedName);
  const textOut = result?.outputs.find((o) => o.type === "text" && o.text);

  // Chain: run another tool on the result.
  const chainTo = (id: string) => {
    if (!firstSaved?.savedName) return;
    const name = firstSaved.savedName;
    setSrc({ name, kind: firstSaved.type === "video" ? "video" : "image", getSrc: () => api.getSavedImage(name) });
    setCurrentId(id);
  };
  const chainable = useMemo(() => {
    const vid = firstSaved?.type === "video";
    const ids: readonly string[] = vid ? VIDEO_TOOL_IDS : [...EDIT_TOOL_IDS, ...UTILITY_TOOL_IDS];
    return ids
      .map((id) => toolById(tools, id))
      .filter((x): x is ToolInfo => !!x && x.badge !== "unavailable" && x.id !== "video-concat");
  }, [tools, firstSaved?.type]);

  const stageLabel = (st: string) => t(`tools.stage.${KNOWN_STAGES.has(st) ? st : "running"}`);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        onInteractOutside={(e) => e.preventDefault()}
        className="ring-border/60 flex max-h-[92vh] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl ring-1 sm:max-w-4xl"
      >
        <header className="flex items-center gap-3 border-b px-5 py-3.5 pr-12">
          <span className="brand-surface flex size-8 items-center justify-center rounded-xl text-white">
            <ToolIcon id={currentId} className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              {tool ? toolName(t, tool) : currentId}
              {tool && <ToolBadgeChip badge={tool.badge} />}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground truncate text-xs">
              {tool ? t(`tools.desc.${tool.id}`, { defaultValue: tool.description }) : ""}
            </DialogDescription>
          </div>
          {isMaskTool && phase !== "done" && (
            <Segmented<string>
              size="sm"
              value={currentId}
              onChange={setCurrentId}
              items={MASK_TOOLS.map((id) => ({
                value: id,
                label: tool ? toolName(t, toolById(tools, id) ?? { id, name: id }) : id,
              }))}
            />
          )}
        </header>

        {!tool ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 p-10 text-sm">
            <Loader2 className="size-4 animate-spin" /> {t("tools.loading")}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 gap-0 overflow-hidden md:grid-cols-[1fr_300px]">
            {/* Left: the image / mask editor / result. */}
            <div className="bg-muted/30 relative flex min-h-[280px] items-center justify-center overflow-auto p-4">
              {phase === "done" && (resultSrc || textOut) ? (
                <ResultView
                  before={srcData}
                  after={resultSrc}
                  text={textOut?.text}
                  showBefore={showBefore}
                />
              ) : !srcData ? (
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
                      setError({ ...e, cloudRetry: undefined });
                      setPhase("error");
                    }}
                    disabled={phase === "running"}
                  />
                </div>
              ) : currentId === "outpaint" ? (
                <OutpaintFrame src={srcData} params={params} />
              ) : isVideo(srcData) ? (
                <video src={srcData} controls loop className="max-h-[60vh] max-w-full rounded-lg" />
              ) : (
                <img src={srcData} alt="" className="max-h-[60vh] max-w-full rounded-lg object-contain shadow" />
              )}
              {phase === "running" && !isMaskTool && (
                <div className="absolute inset-0 bg-black/20" />
              )}
            </div>

            {/* Right: form, where it runs, progress, result actions. */}
            <div className="flex min-h-0 flex-col border-l">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                {phase !== "done" && (
                  <>
                    {currentId === "outpaint" && (
                      <OutpaintSides params={params} onChange={(k, v) => setParams((p) => ({ ...p, [k]: v }))} />
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
                      disabled={phase === "running"}
                    />
                    <RunOnPicker tool={tool} value={runOn} onChange={setRunOn} rail={rail} />
                    <WhereNotice tool={tool} cloud={effectiveCloud} rail={rail} />
                  </>
                )}

                {phase === "running" && (
                  <div className="space-y-2 rounded-xl border p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Loader2 className="size-4 animate-spin" />
                      {stageLabel(progress?.stage ?? "starting")}
                    </div>
                    <ProgressBar
                      percent={progress && progress.fraction > 0 ? progress.fraction * 100 : null}
                    />
                  </div>
                )}

                {phase === "error" && error && (
                  <ErrorPanel
                    error={error}
                    rail={rail}
                    onCloud={() => {
                      setRunOn("cloud");
                      void run("cloud");
                    }}
                  />
                )}

                {phase === "done" && result && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                      <Check className="size-4" />
                      {firstSaved ? t("tools.savedToGallery") : t("tools.done")}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {t(result.ranOn === "cloud" ? "tools.ranCloud" : "tools.ranLocal", {
                        seconds: (result.durationMs / 1000).toFixed(1),
                      })}
                      {result.ranOn === "cloud" && result.credits
                        ? " · " + formatToolPrice(t, result.credits, rail)
                        : ""}
                    </p>
                    {textOut?.text && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => {
                          void navigator.clipboard?.writeText(textOut.text ?? "").catch(() => {});
                          setCopied(true);
                          window.setTimeout(() => setCopied(false), 1500);
                        }}
                      >
                        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                        {t("tools.copyText")}
                      </Button>
                    )}
                    {firstSaved?.savedName && (
                      <div className="grid gap-1.5">
                        {resultSrc && firstSaved.type !== "video" && (
                          <Button variant="outline" size="sm" onClick={() => setShowBefore((b) => !b)}>
                            <SplitSquareHorizontal className="size-3.5" />
                            {showBefore ? t("tools.showingBefore") : t("tools.beforeAfter")}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            onOpenSaved(firstSaved.savedName!);
                            close();
                          }}
                        >
                          <Maximize2 className="size-3.5" /> {t("tools.open")}
                        </Button>
                        {firstSaved.type !== "video" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const n = firstSaved.savedName!;
                              onUseAsSource(() => api.getSavedImage(n));
                              close();
                            }}
                          >
                            <ImageIcon className="size-3.5" /> {t("tools.useAsSource")}
                          </Button>
                        )}
                        {firstSaved.path && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void api.revealInFolder(firstSaved.path!).catch(() => {})}
                          >
                            <FolderOpen className="size-3.5" /> {t("tools.reveal")}
                          </Button>
                        )}
                      </div>
                    )}
                    {firstSaved?.savedName && chainable.length > 0 && (
                      <div className="grid gap-1.5 border-t pt-3">
                        <span className="text-muted-foreground text-xs font-medium">{t("tools.chain")}</span>
                        <Select size="sm" fullWidth value="" onChange={(v) => v && chainTo(v)} aria-label={t("tools.chain")}>
                          <option value="">{t("tools.chainPick")}</option>
                          {chainable.map((x) => (
                            <option key={x.id} value={x.id}>
                              {toolName(t, x)}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <footer className="flex items-center gap-2 border-t p-3">
                {phase === "running" ? (
                  <Button variant="outline" className="flex-1" onClick={cancel}>
                    <Square className="size-3.5" /> {t("common.cancel")}
                  </Button>
                ) : phase === "done" ? (
                  <>
                    <Button variant="outline" className="flex-1" onClick={() => setPhase("form")}>
                      {t("tools.again")}
                    </Button>
                    <Button className="flex-1" onClick={close}>
                      {t("common.done")}
                    </Button>
                  </>
                ) : (
                  <Button
                    className="flex-1"
                    disabled={!srcData || tool.badge === "unavailable" || (isMaskTool && !hasMask)}
                    onClick={() => void run()}
                  >
                    <Play className="size-3.5" />
                    {effectiveCloud
                      ? t("tools.runCloud", {
                          price: formatToolPrice(t, tool.priceCredits, rail, tool.priceIsModel),
                        })
                      : t("tools.run")}
                  </Button>
                )}
              </footer>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------------

function ResultView({
  before,
  after,
  text,
  showBefore,
}: {
  before: string | null;
  after: string | null;
  text?: string;
  showBefore: boolean;
}) {
  if (text && !after) {
    return (
      <div className="flex w-full flex-col items-center gap-3">
        {before && <img src={before} alt="" className="max-h-[36vh] max-w-full rounded-lg object-contain" />}
        <p className="bg-background w-full max-w-xl rounded-xl border p-3 text-sm leading-relaxed select-text">{text}</p>
      </div>
    );
  }
  const shown = showBefore ? before : after;
  if (!shown) return null;
  if (isVideo(shown)) {
    return <video src={shown} controls autoPlay loop className="max-h-[60vh] max-w-full rounded-lg" />;
  }
  return (
    <img
      src={shown}
      alt=""
      className="checkerboard max-h-[60vh] max-w-full rounded-lg object-contain shadow"
    />
  );
}

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
          { value: "auto", label: t("tools.mode.auto") },
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

function WhereNotice({ tool, cloud, rail }: { tool: ToolInfo; cloud: boolean; rail: string }) {
  const { t } = useTranslation();
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
        {tool.weightsMb > 0 && (
          <p className="text-muted-foreground">{t("tools.weightsNote", { mb: Math.round(tool.weightsMb) })}</p>
        )}
      </div>
    </div>
  );
}

function ErrorPanel({ error, rail, onCloud }: { error: ToolError; rail: string; onCloud: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="border-destructive/25 bg-destructive/5 space-y-2 rounded-xl border p-3 text-xs">
      <div className="text-destructive flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-medium">{t(`tools.errors.${error.code}`, { defaultValue: t("tools.errors.internal") })}</p>
          <p className="text-destructive/80 mt-0.5 break-words">{error.message}</p>
        </div>
      </div>
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
