import type * as React from "react";

/** A key cap, for shortcuts shown in text (welcome tour, empty states). */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="bg-muted text-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-md border px-1 font-sans text-2xs font-medium">
      {children}
    </kbd>
  );
}
