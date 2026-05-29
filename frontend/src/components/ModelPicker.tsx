import { useEffect, useState } from "react";
import { Download, Loader2, CheckCircle2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/wails-bridge";
import type { InstallProgress, ModelInfo } from "@/lib/types";

type Props = {
  // Currently-active local model code (settings.localModel?.modelCode), so the
  // picker can mark it and disable a redundant re-download.
  activeModelCode: string | null;
  // Called after a model switch completes so the parent can refetch settings
  // (sdxlPath + localModel now changed, and generation defaults follow).
  onModelSelected: () => void;
};

export function ModelPicker({ activeModelCode, onModelSelected }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedCode, setSelectedCode] = useState<string>("");
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [busy, setBusy] = useState(false);

  // Load the catalog on mount. Seed the dropdown with the active model.
  useEffect(() => {
    let alive = true;
    void api
      .listLocalModels()
      .then((list) => {
        if (!alive) return;
        setModels(list);
        setListError(null);
        setSelectedCode((cur) => cur || activeModelCode || list[0]?.modelCode || "");
      })
      .catch((e) => {
        if (!alive) return;
        setListError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [activeModelCode]);

  // Subscribe to download/switch progress for the section's lifetime.
  useEffect(() => {
    return api.onModelProgress((p) => {
      setProgress(p);
      if (p.done || p.phase === "done" || p.phase === "error") {
        setBusy(false);
        if (p.phase === "done") onModelSelected();
      } else {
        setBusy(true);
      }
    });
  }, [onModelSelected]);

  const selected = models.find((m) => m.modelCode === selectedCode) ?? null;
  const isActive = !!selected && selected.modelCode === activeModelCode;

  const choose = async () => {
    if (!selected) return;
    setBusy(true);
    setProgress({ phase: "model", message: `Preparing ${selected.name}`, percentEstimate: 0, done: false });
    try {
      await api.selectLocalModel(selected.modelCode);
    } catch (e) {
      setBusy(false);
      setProgress({
        phase: "error",
        message: "",
        percentEstimate: 0,
        done: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <section className="border-border rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Local model</h3>
        {activeModelCode && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[11px] font-medium text-green-700">
            <CheckCircle2 className="size-3" />
            {models.find((m) => m.modelCode === activeModelCode)?.name ?? activeModelCode}
          </span>
        )}
      </div>

      {listError ? (
        <p className="text-destructive text-xs">
          Couldn’t load the model catalog ({listError}). Check your internet connection.
        </p>
      ) : loading ? (
        <p className="text-muted-foreground text-xs">
          <Loader2 className="mr-1 inline size-3 animate-spin" />
          Loading models…
        </p>
      ) : (
        <div className="grid gap-3">
          <div className="flex items-end gap-2">
            <div className="grid flex-1 gap-1.5">
              <label htmlFor="modelSelect" className="text-xs font-medium">
                Choose a model ({models.length} available)
              </label>
              <select
                id="modelSelect"
                value={selectedCode}
                disabled={busy}
                onChange={(e) => setSelectedCode(e.target.value)}
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              >
                {models.map((m) => (
                  <option key={m.modelCode} value={m.modelCode}>
                    {m.name}
                    {m.modelCode === activeModelCode ? "  ✓ (active)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <Button size="sm" onClick={choose} disabled={busy || isActive}>
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : isActive ? (
                <RefreshCw className="size-3.5" />
              ) : (
                <Download className="size-3.5" />
              )}
              {isActive ? "Active" : "Download & use"}
            </Button>
          </div>

          {selected && <ModelDetails m={selected} />}
        </div>
      )}

      {busy && progress && <ProgressView p={progress} />}
      {progress?.error && !busy && <p className="text-destructive mt-2 text-xs">{progress.error}</p>}

      <p className="text-muted-foreground/70 mt-3 text-[11px]">
        Switching models downloads new weights (~6–7 GB) and deletes the previously downloaded one.
        Detailed progress streams to the Logs panel.
      </p>
    </section>
  );
}

function ModelDetails({ m }: { m: ModelInfo }) {
  return (
    <div className="bg-muted/40 grid gap-1.5 rounded-md p-3 text-xs">
      {m.mediumDescription && (
        <p className="text-muted-foreground">{m.mediumDescription}</p>
      )}
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
        <span>steps: {m.stepsDefault}</span>
        <span>cfg: {m.cfgDefault}</span>
        {m.skipDefault > 0 && <span>clip-skip: {m.skipDefault}</span>}
        {m.schedulerDefault && <span>sampler: {m.schedulerDefault}</span>}
      </div>
    </div>
  );
}

function ProgressView({ p }: { p: InstallProgress }) {
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">{p.message || "Working…"}</span>
        {p.percentEstimate > 0 && <span className="tabular-nums">{p.percentEstimate}%</span>}
      </div>
      <div className="bg-muted h-1.5 w-full overflow-hidden rounded">
        <div
          className={
            "h-full transition-all " +
            (p.percentEstimate > 0 ? "bg-primary" : "animate-pulse bg-primary/50 w-full")
          }
          style={p.percentEstimate > 0 ? { width: `${p.percentEstimate}%` } : undefined}
        />
      </div>
    </div>
  );
}
