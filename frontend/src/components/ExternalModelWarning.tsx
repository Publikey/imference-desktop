import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/types";

/** A model run by a third-party provider (OpenAI...): the prompt and the
 *  images leave imference and follow that provider's rules. Shown under the
 *  cloud model pickers (Create, Edit with instructions). */
export function ExternalModelWarning({ model, className }: { model?: ModelInfo | null; className?: string }) {
  const { t } = useTranslation();
  if (!model?.external) return null;
  return (
    <div
      className={cn(
        "ds-callout ds-callout-warning flex gap-2 p-2.5 text-xs leading-snug",
        className
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <p>
        <span className="font-medium">{t("external.title", { name: model.name || model.modelCode })}</span>{" "}
        {t("external.body")}
      </p>
    </div>
  );
}
