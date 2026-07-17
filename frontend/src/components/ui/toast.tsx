import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastVariant = "default" | "success" | "error";
type Toast = { id: number; message: string; variant: ToastVariant; duration: number };
type ToastInput = { variant?: ToastVariant; duration?: number };

type ToastApi = {
  toast: (message: string, opts?: ToastInput) => void;
  success: (message: string, opts?: ToastInput) => void;
  error: (message: string, opts?: ToastInput) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** App-wide transient feedback. Wrap the app once; call `useToast()` anywhere. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message: string, opts?: ToastInput) => {
    const id = nextId.current++;
    const duration = opts?.duration ?? 3200;
    setToasts((cur) => [...cur, { id, message, variant: opts?.variant ?? "default", duration }]);
  }, []);

  // Stable identity so callers can safely list `toast` in effect deps.
  const api = useMemo<ToastApi>(
    () => ({
      toast: push,
      success: (m, o) => push(m, { ...o, variant: "success" }),
      error: (m, o) => push(m, { ...o, variant: "error" }),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* bottom-24: clears the persistent ActivityDock widget in the corner. */}
      <div className="pointer-events-none fixed bottom-24 right-6 z-[80] flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} onDone={() => remove(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast.duration, onDone]);

  const Icon = toast.variant === "success" ? Check : toast.variant === "error" ? AlertTriangle : Info;
  return (
    <div
      role="status"
      className={cn(
        "toast-in pointer-events-auto flex max-w-sm items-center gap-2 rounded-full py-1.5 pl-3 pr-2 text-xs font-medium shadow-lg ring-1",
        toast.variant === "error"
          ? "bg-destructive text-white ring-black/10"
          : "bg-foreground text-background ring-black/10"
      )}
    >
      <Icon
        className={cn(
          "size-3.5 shrink-0",
          toast.variant === "success" && "text-emerald-400",
          toast.variant === "default" && "opacity-80"
        )}
      />
      <span className="min-w-0 flex-1 truncate">{toast.message}</span>
      <button
        type="button"
        onClick={onDone}
        aria-label="Dismiss"
        className="shrink-0 rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
