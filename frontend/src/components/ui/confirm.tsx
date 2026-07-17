import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm action as destructive (red). Default true — most callers
   *  are delete confirmations. */
  destructive?: boolean;
};

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** App-wide confirmation dialog. Replaces window.confirm() with a themed modal.
 *  Wrap the app once; call `const confirm = useConfirm()` then `await confirm({…})`. */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((next) => {
    setOpts(next);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  // Settle the pending promise and close. Guard against a double-settle (e.g.
  // clicking a button and the overlay's onOpenChange both firing).
  const settle = useCallback((value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setOpts(null);
  }, []);

  const api = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={api}>
      {children}
      <Dialog open={!!opts} onOpenChange={(o) => !o && settle(false)}>
        {opts && (
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{opts.title}</DialogTitle>
              {opts.description && <DialogDescription>{opts.description}</DialogDescription>}
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => settle(false)}>
                {opts.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={opts.destructive === false ? "default" : "destructive"}
                onClick={() => settle(true)}
                autoFocus
              >
                {opts.confirmLabel ?? "Confirm"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}
