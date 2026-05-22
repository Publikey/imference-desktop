import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, RefreshCw, Loader2, AlertTriangle, KeyRound, Wallet, Plus, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/wails-bridge";
import type { WalletInfo } from "@/lib/types";

// View states keep replace/import/export confirmations inline (vs nested
// dialogs which Radix can handle but become focus-management hell when
// already inside the Settings dialog).
type View = "initial" | "summary" | "import" | "confirm-replace" | "export";

const REFRESH_INTERVAL_MS = 30_000;

type Props = {
  /** Called whenever the wallet state changes (generate/import/replace).
   *  Receives the new address. Parent (SettingsDialog) merges this into
   *  its draft WITHOUT re-fetching full settings — the draft has unsaved
   *  UI state (like the paymentMode radio) that a full refetch would
   *  clobber back to the on-disk values. */
  onChanged: (newAddress: string) => void;
};

export function WalletSection({ onChanged }: Props) {
  const [info, setInfo] = useState<WalletInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("initial");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importDraft, setImportDraft] = useState("");
  const [exportedKey, setExportedKey] = useState<string | null>(null);
  const [keyShown, setKeyShown] = useState(false);

  // Auto-refresh balance every 30s when configured + section visible.
  // useRef avoids re-creating the interval each render.
  const refreshTimer = useRef<number | null>(null);

  const reload = useCallback(async (force = false) => {
    try {
      const fresh = await api.getWalletInfo();
      setInfo(fresh);
      setView(fresh.configured ? "summary" : "initial");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // Force-refresh just the balance via the dedicated endpoint — the
    // cached GetWalletInfo call above already does balance fetch, so we
    // only need the extra call when the caller explicitly wants a bypass.
    if (force) {
      try {
        const fresh = await api.refreshWalletBalance();
        setInfo((prev) => (prev ? { ...prev, balanceUSDC: fresh, error: "" } : prev));
      } catch (e) {
        setInfo((prev) => (prev ? { ...prev, error: e instanceof Error ? e.message : String(e) } : prev));
      }
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      if (refreshTimer.current !== null) window.clearInterval(refreshTimer.current);
    };
  }, [reload]);

  useEffect(() => {
    if (refreshTimer.current !== null) {
      window.clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    }
    if (info?.configured) {
      refreshTimer.current = window.setInterval(() => void reload(true), REFRESH_INTERVAL_MS);
    }
    return () => {
      if (refreshTimer.current !== null) {
        window.clearInterval(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [info?.configured, reload]);

  const onGenerate = async () => {
    setBusy(true);
    setError(null);
    try {
      const addr = await api.generateWallet();
      onChanged(addr);
      await reload(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const addr = await api.importWallet(importDraft.trim());
      setImportDraft("");
      onChanged(addr);
      await reload(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const key = await api.exportWalletPrivateKey();
      setExportedKey(key);
      setKeyShown(false);
      setView("export");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };

  if (loading) {
    return <section className="text-muted-foreground text-xs">Loading wallet…</section>;
  }

  return (
    <section className="border-border rounded-lg border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Wallet className="size-4" />
        <h3 className="text-sm font-semibold">Wallet (Base mainnet · USDC)</h3>
      </div>

      {error && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {view === "initial" && (
        <InitialView busy={busy} onGenerate={onGenerate} onImport={() => setView("import")} />
      )}

      {view === "summary" && info && (
        <SummaryView
          info={info}
          busy={busy}
          onCopy={onCopy}
          onRefresh={() => void reload(true)}
          onReplace={() => setView("confirm-replace")}
          onExport={onExport}
        />
      )}

      {view === "import" && (
        <ImportView
          draft={importDraft}
          setDraft={setImportDraft}
          busy={busy}
          onImport={onImport}
          onCancel={() => {
            setImportDraft("");
            setError(null);
            setView(info?.configured ? "summary" : "initial");
          }}
        />
      )}

      {view === "confirm-replace" && (
        <ConfirmReplaceView
          busy={busy}
          onGenerate={async () => {
            await onGenerate();
          }}
          onImport={() => setView("import")}
          onCancel={() => setView("summary")}
        />
      )}

      {view === "export" && exportedKey && (
        <ExportView
          privateKey={exportedKey}
          shown={keyShown}
          setShown={setKeyShown}
          onCopy={() => onCopy(exportedKey)}
          onClose={() => {
            setExportedKey(null);
            setKeyShown(false);
            setView("summary");
          }}
        />
      )}

      <p className="text-muted-foreground/70 mt-3 text-[11px] leading-snug italic">
        This wallet's private key lives in Windows Credential Manager on this machine. Treat it
        as a burner: only fund what you're OK losing. Use "Export private key" to back it up
        before relying on it.
      </p>
    </section>
  );
}

function InitialView({
  busy,
  onGenerate,
  onImport,
}: {
  busy: boolean;
  onGenerate: () => void;
  onImport: () => void;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        x402 needs an EVM wallet on Base mainnet to pay per generation (0.05 USDC per image).
        Recommended: generate a burner wallet here and fund it with a few dollars from your
        MetaMask.
      </p>
      <div className="flex gap-2">
        <Button onClick={onGenerate} disabled={busy} className="gap-1.5">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          Generate new wallet
        </Button>
        <Button variant="outline" onClick={onImport} disabled={busy} className="gap-1.5">
          <KeyRound className="size-3.5" />
          Import existing private key
        </Button>
      </div>
    </div>
  );
}

function SummaryView({
  info,
  busy,
  onCopy,
  onRefresh,
  onReplace,
  onExport,
}: {
  info: WalletInfo;
  busy: boolean;
  onCopy: (s: string) => void;
  onRefresh: () => void;
  onReplace: () => void;
  onExport: () => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label className="text-muted-foreground text-xs">Address</Label>
        <div className="flex items-center gap-2">
          <code className="bg-muted/40 flex-1 truncate rounded px-2 py-1 font-mono text-xs" title={info.address}>
            {info.address}
          </code>
          <Button size="icon" variant="ghost" onClick={() => onCopy(info.address)} title="Copy">
            <Copy className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid gap-1">
        <Label className="text-muted-foreground text-xs">USDC balance</Label>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">{info.balanceUSDC || "0.0"}</span>
          <span className="text-muted-foreground text-xs">USDC</span>
          <Button size="icon" variant="ghost" onClick={onRefresh} disabled={busy} className="ml-auto" title="Refresh">
            <RefreshCw className={"size-3.5 " + (busy ? "animate-spin" : "")} />
          </Button>
        </div>
        {info.error && (
          <p className="text-destructive text-[11px]">RPC error: {info.error}</p>
        )}
        <p className="text-muted-foreground text-[11px]">
          Fund this address with USDC on Base from your MetaMask (or any wallet). Balance refreshes every 30 s.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onExport} disabled={busy} className="gap-1.5">
          <KeyRound className="size-3.5" />
          Export private key
        </Button>
        <Button size="sm" variant="destructive" onClick={onReplace} disabled={busy} className="ml-auto gap-1.5">
          <AlertTriangle className="size-3.5" />
          Replace wallet
        </Button>
      </div>
    </div>
  );
}

function ImportView({
  draft,
  setDraft,
  busy,
  onImport,
  onCancel,
}: {
  draft: string;
  setDraft: (s: string) => void;
  busy: boolean;
  onImport: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="grid gap-3">
      <Label htmlFor="pk">Private key (64 hex chars, with or without 0x prefix)</Label>
      <Textarea
        id="pk"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="0x…"
        className="font-mono text-xs"
        rows={3}
      />
      <p className="text-muted-foreground text-[11px]">
        This will overwrite any existing wallet in your Credential Manager. Make sure you've
        exported the current one if you want to keep it.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy} size="sm">
          Cancel
        </Button>
        <Button onClick={onImport} disabled={busy || !draft.trim()} size="sm" className="gap-1.5">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
          Import
        </Button>
      </div>
    </div>
  );
}

function ConfirmReplaceView({
  busy,
  onGenerate,
  onImport,
  onCancel,
}: {
  busy: boolean;
  onGenerate: () => void;
  onImport: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="grid gap-3 rounded border border-destructive/40 bg-destructive/5 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="text-destructive mt-0.5 size-4 shrink-0" />
        <div className="text-sm">
          <p className="font-medium">Replace the current wallet?</p>
          <p className="text-muted-foreground mt-1 text-xs">
            The current private key will be overwritten in Credential Manager and is unrecoverable
            unless you've exported it. Any USDC at the current address will become inaccessible from
            this app.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy} size="sm">
          Cancel
        </Button>
        <Button variant="destructive" onClick={onImport} disabled={busy} size="sm" className="gap-1.5">
          <KeyRound className="size-3.5" />
          Replace by importing
        </Button>
        <Button variant="destructive" onClick={onGenerate} disabled={busy} size="sm" className="gap-1.5">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
          Replace with new burner
        </Button>
      </div>
    </div>
  );
}

function ExportView({
  privateKey,
  shown,
  setShown,
  onCopy,
  onClose,
}: {
  privateKey: string;
  shown: boolean;
  setShown: (b: boolean) => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div className="grid gap-3 rounded border border-yellow-500/40 bg-yellow-500/5 p-3">
      <p className="text-sm font-medium">Your private key</p>
      <p className="text-muted-foreground text-xs">
        Anyone with this key can spend your USDC. Back it up to a password manager and then close
        this dialog. We don't log or transmit it.
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={shown ? privateKey : "•".repeat(64)}
          readOnly
          className="bg-background/80 font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button size="icon" variant="ghost" onClick={() => setShown(!shown)} title={shown ? "Hide" : "Show"}>
          {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={onCopy} title="Copy">
          <Copy className="size-3.5" />
        </Button>
      </div>
      <div className="flex justify-end">
        <Button onClick={onClose} size="sm" variant="outline">
          Done
        </Button>
      </div>
    </div>
  );
}
